"""CA account management through the existing manager session."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, ConfigDict, Field, StrictBool, StrictInt, field_validator

from .. import security
from ..services import codearts, codearts_dashboard, codearts_groups

router = APIRouter(prefix='/api/ca', tags=['codearts'])


async def _call(awaitable):
    try:
        return await awaitable
    except codearts.CodeArtsError as exc:
        raise HTTPException(exc.status, detail=str(exc)) from exc


class CallbackIn(BaseModel):
    callback_url: str = Field(min_length=1, max_length=8192)


class LoginIn(BaseModel):
    group_id: int | None = Field(default=None, ge=1, strict=True)


class GroupIn(BaseModel):
    name: str = Field(min_length=1, max_length=64)


class AssignGroupIn(BaseModel):
    account_ids: list[str] = Field(min_length=1, max_length=200)
    group_id: int | None = Field(default=None, ge=1, strict=True)


class AccountPatch(BaseModel):
    enabled: bool | None = None
    nickname: str | None = Field(default=None, min_length=1, max_length=128)


class AutoCheckinIn(BaseModel):
    model_config = ConfigDict(extra='forbid')
    enabled: StrictBool | None = None
    times: list[str] | None = Field(default=None, min_length=2, max_length=2)
    jitter_minutes: StrictInt | None = Field(default=None, ge=0, le=120)

    @field_validator('times')
    @classmethod
    def valid_times(cls, value):
        import re
        if value is not None and (len(set(value)) != 2 or any(
                not re.fullmatch(r'(?:[01]\d|2[0-3]):[0-5]\d', v) for v in value)):
            raise ValueError('请设置两个不同的有效时刻，格式为 HH:MM')
        return sorted(value) if value else value


@router.get('/accounts')
async def list_accounts(user: dict = Depends(security.current_user)) -> dict:
    return {'platform': 'ca', 'accounts': await _call(codearts.accounts())}


@router.get('/dashboard')
async def dashboard(days: int = Query(default=14, ge=1, le=90),
                    user: dict = Depends(security.current_user)) -> dict:
    return await _call(codearts_dashboard.dashboard(days))


@router.post('/auth/start')
async def start_login(body: LoginIn | None = None,
                      user: dict = Depends(security.require_session_admin)) -> dict:
    try:
        result = await _call(codearts.start_login(body.group_id if body else None))
    except ValueError as exc:
        raise HTTPException(400, detail=str(exc)) from exc
    security.audit(user, 'ca_login_start', result['account_id'])
    return result


@router.get('/groups')
def list_groups(user: dict = Depends(security.current_user)) -> dict:
    return {'groups': codearts_groups.list_groups()}


@router.post('/groups')
def create_group(body: GroupIn, user: dict = Depends(security.require_session_admin)) -> dict:
    try:
        result = codearts_groups.save_group(body.name)
    except ValueError as exc:
        raise HTTPException(400, detail=str(exc)) from exc
    security.audit(user, 'ca_group_create', str(result['id']), result['name'])
    return result


@router.patch('/groups/{group_id}')
def rename_group(group_id: int, body: GroupIn,
                 user: dict = Depends(security.require_session_admin)) -> dict:
    try:
        result = codearts_groups.save_group(body.name, group_id)
    except ValueError as exc:
        raise HTTPException(400, detail=str(exc)) from exc
    security.audit(user, 'ca_group_update', str(group_id), result['name'])
    return result


@router.delete('/groups/{group_id}')
def delete_group(group_id: int, user: dict = Depends(security.require_session_admin)) -> dict:
    try:
        codearts_groups.delete_group(group_id)
    except ValueError as exc:
        raise HTTPException(409, detail=str(exc)) from exc
    security.audit(user, 'ca_group_delete', str(group_id))
    return {'ok': True}


@router.post('/accounts/group')
async def assign_group(body: AssignGroupIn,
                        user: dict = Depends(security.require_session_admin)) -> dict:
    known = {a['id'] for a in await _call(codearts.accounts())}
    if any(account_id not in known for account_id in body.account_ids):
        raise HTTPException(404, detail='存在无效的 CA 账号，请刷新后重试')
    try:
        codearts_groups.assign(body.account_ids, body.group_id)
    except ValueError as exc:
        raise HTTPException(400, detail=str(exc)) from exc
    security.audit(user, 'ca_group_assign', str(body.group_id or 'ungrouped'),
                   '账号数=' + str(len(set(body.account_ids))))
    return {'ok': True}


@router.get('/auth/{account_id}/poll')
async def poll_login(account_id: str, user: dict = Depends(security.require_session_admin)) -> dict:
    return await _call(codearts.poll_login(account_id))


@router.post('/auth/{account_id}/callback')
async def submit_callback(account_id: str, body: CallbackIn,
                          user: dict = Depends(security.require_session_admin)) -> dict:
    # Authorization parameters only travel to the official pending flow; never audit the URL.
    return await _call(codearts.submit_callback(account_id, body.callback_url))


@router.post('/auth/{account_id}/cancel')
async def cancel_login(account_id: str, user: dict = Depends(security.require_session_admin)) -> dict:
    return await _call(codearts.cancel_login(account_id))


@router.get('/credits')
async def credits(force: bool = False, user: dict = Depends(security.current_user)) -> dict:
    return await _call(codearts.credits(force))


@router.post('/checkin')
async def checkin(user: dict = Depends(security.require_session_admin)) -> dict:
    result = await _call(codearts.checkin())
    security.audit(user, 'ca_checkin', 'codearts', '账号数=' + str(len(result['results'])))
    return result


@router.get('/auto-checkin')
async def auto_checkin(user: dict = Depends(security.current_user)) -> dict:
    return await _call(codearts.auto_checkin())


@router.patch('/auto-checkin')
async def save_auto_checkin(body: AutoCheckinIn, user: dict = Depends(security.require_session_admin)) -> dict:
    patch = {k: v for k, v in body.model_dump(exclude_unset=True).items() if v is not None}
    result = await _call(codearts.auto_checkin(patch))
    security.audit(user, 'ca_auto_checkin', 'codearts', '字段=' + ','.join(patch))
    return result


@router.patch('/accounts/{account_id}')
async def update_account(account_id: str, body: AccountPatch,
                         user: dict = Depends(security.require_session_admin)) -> dict:
    patch = {k: v for k, v in body.model_dump(exclude_unset=True).items() if v is not None}
    if 'nickname' in patch:
        patch['nickname'] = patch['nickname'].strip()
        if not patch['nickname']:
            raise HTTPException(400, detail='账号名称不能为空')
    result = await _call(codearts.update_account(account_id, patch))
    security.audit(user, 'ca_account_update', account_id, '字段=' + ','.join(patch))
    return result


@router.delete('/accounts/{account_id}')
async def delete_account(account_id: str, user: dict = Depends(security.require_session_admin)) -> dict:
    result = await _call(codearts.delete_account(account_id))
    security.audit(user, 'ca_account_delete', account_id)
    return result


@router.post('/accounts/{account_id}/refresh')
async def refresh_account(account_id: str, user: dict = Depends(security.require_session_admin)) -> dict:
    result = await _call(codearts.refresh_account(account_id))
    security.audit(user, 'ca_account_refresh', account_id)
    return result
