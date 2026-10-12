let pending = Buffer.alloc(0);
const delayMs = Number(process.argv[2] ?? 0);
function send(message) {
  const body = Buffer.from(JSON.stringify(message));
  process.stdout.write('Content-Length: ' + body.length + '\r\n\r\n');
  process.stdout.write(body);
}
process.stdin.on('data', (chunk) => {
  pending = Buffer.concat([pending, chunk]);
  while (true) {
    const end = pending.indexOf('\r\n\r\n');
    if (end < 0) return;
    const length = Number(/Content-Length:\s*(\d+)/i.exec(pending.subarray(0, end).toString())?.[1]);
    if (pending.length < end + 4 + length) return;
    const message = JSON.parse(pending.subarray(end + 4, end + 4 + length).toString());
    pending = pending.subarray(end + 4 + length);
    if (message.method === 'initialize') send({ jsonrpc: '2.0', id: message.id, result: { capabilities: { hoverProvider: true, textDocumentSync: { openClose: true } } } });
    else if (message.method === 'textDocument/hover') {
      const respond = () => send({ jsonrpc: '2.0', id: message.id, result: { contents: 'Isolated sandboxed hover' } });
      if (delayMs > 0) setTimeout(respond, delayMs); else respond();
    }
    else if (message.method === 'shutdown') send({ jsonrpc: '2.0', id: message.id, result: null });
    else if (message.method === 'exit') process.exit(0);
  }
});
process.stdin.once('end', () => process.exit(0));
