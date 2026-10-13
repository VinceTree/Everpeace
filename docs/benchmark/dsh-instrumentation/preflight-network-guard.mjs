import net from 'node:net';
import { syncBuiltinESMExports } from 'node:module';

const blocked = () => {
  throw new Error('Network access is disabled during the Everpeace dsh preflight');
};

function localOwner(args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const path = typeof first === 'string' ? first : first?.path;
  return process.platform === 'win32' && typeof path === 'string'
    && /^\\\\\.\\pipe\\everpeace-owner-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(path);
}
for (const [target, key] of [[net.Socket.prototype, 'connect'], [net, 'connect'], [net, 'createConnection']]) {
  const original = target[key];
  target[key] = function (...args) { if (!localOwner(args)) return blocked(); return Reflect.apply(original, this, args); };
}
syncBuiltinESMExports();
