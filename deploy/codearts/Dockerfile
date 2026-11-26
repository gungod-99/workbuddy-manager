ARG CODEARTS_IMAGE=ghcr.io/zhuweiyou/codearts2api:0.1.12@sha256:d677eda1bc5ca5613c4a3fe25a02e5b8852792b2ab1a6786fcd4d0be1567300c
FROM ${CODEARTS_IMAGE}
USER root
COPY deploy/codearts /integration
RUN node /integration/patch.mjs /app \
    && mkdir -p /data /connection \
    && chown 10001:10001 /data /connection
ENV HOST=0.0.0.0 PORT=8092 PROXY_GATEWAY=1 CODEARTS2API_ADMIN_AUTH=1 \
    CODEARTS2API_HOME=/data DSH_OPENAI_GATEWAY_PORT=8326 DSH_JET_HUB_AUTO_OPEN_BROWSER=0
USER 10001:10001
VOLUME ["/data", "/connection"]
EXPOSE 8092
HEALTHCHECK --interval=10s --timeout=5s --start-period=60s --retries=12 \
    CMD node -e "fetch('http://127.0.0.1:8092/healthz').then(async r=>{const h=await r.json();process.exit(r.ok&&h.ok&&h.adminAuth?0:1)}).catch(()=>process.exit(1))"
CMD ["node", "/integration/bootstrap.mjs"]
