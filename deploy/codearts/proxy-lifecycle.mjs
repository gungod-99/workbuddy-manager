export function proxyRequestLifecycle(request, response, timeoutMs) {
  const controller = new AbortController();
  let disconnected = false;
  const timer = setTimeout(() => {
    controller.abort(new DOMException('Gateway upstream deadline exceeded', 'TimeoutError'));
  }, timeoutMs);
  timer.unref?.();
  const cleanup = () => {
    clearTimeout(timer);
    request.removeListener('aborted', onAbort);
    response.removeListener('close', onClose);
    response.removeListener('finish', cleanup);
  };
  const onAbort = () => {
    disconnected = true;
    controller.abort(new DOMException('Client disconnected', 'AbortError'));
    cleanup();
  };
  const onClose = () => {
    if (!response.writableEnded) onAbort();
    else cleanup();
  };
  request.once('aborted', onAbort);
  response.once('close', onClose);
  response.once('finish', cleanup);
  if (request.aborted || response.destroyed) onAbort();
  return {signal: controller.signal, cleanup, clientDisconnected: () => disconnected};
}

// Only names/codes are logged. Fetch messages may embed URLs or credentials.
export function proxyFailureDetail(error) {
  const labels = [];
  let current = error;
  for (let depth = 0; current && depth < 4; depth++, current = current.cause) {
    for (const value of [current.name, current.code]) {
      if (typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value) && !labels.includes(value)) labels.push(value);
    }
  }
  return labels.join('/') || 'UnknownFetchError';
}
