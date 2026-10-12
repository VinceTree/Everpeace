import net from 'node:net';

const blocked = () => {
  throw new Error('Network access is disabled during the Everpeace dsh preflight');
};

net.Socket.prototype.connect = blocked;
net.connect = blocked;
net.createConnection = blocked;
