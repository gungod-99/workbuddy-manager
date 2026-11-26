const active = new WeakMap();

// A comment is protocol neutral: clients can wait for a slow first model event
// without mistaking a quiet TCP connection for an unavailable gateway.
export function startSseKeepalive(response, intervalMs = 15_000) {
  const existing = active.get(response);
  if (existing) return existing;
  if (response.destroyed || response.writableEnded) return () => {};
  let timer;
  const stop = () => {
    clearInterval(timer);
    response.removeListener('close', stop);
    response.removeListener('finish', stop);
    active.delete(response);
  };
  const ping = () => {
    if (response.destroyed || response.writableEnded) {
      stop();
      return;
    }
    // Do not queue heartbeats behind a client that has stopped reading.
    if (!response.writableNeedDrain) response.write(': keep-alive\n\n');
  };
  active.set(response, stop);
  response.once('close', stop);
  response.once('finish', stop);
  response.flushHeaders();
  ping();
  timer = setInterval(ping, intervalMs);
  timer.unref?.();
  return stop;
}
