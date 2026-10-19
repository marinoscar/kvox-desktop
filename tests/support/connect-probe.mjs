// A tiny stand-in for the Copilot runtime (marinoscar/kvox-desktop#23): a separate PROCESS that finds its proxy
// the way the real runtime does (HTTPS_PROXY / NO_PROXY in its environment) and tries to open an HTTPS tunnel to
// each host named on the command line. Prints one JSON line per host: { host, status } (status 0: no answer).
import net from 'node:net';

const proxy = new URL(process.env.HTTPS_PROXY ?? '');
const credentials = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`;
const withCredentials = process.env.PROBE_NO_CREDENTIALS !== '1';

function tunnel(host) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: proxy.hostname, port: Number(proxy.port) });
    let received = '';
    const done = (status, echoed) => {
      socket.destroy();
      resolve({ host, status, echoed });
    };
    socket.setTimeout(5000, () => done(0));
    socket.on('error', () => done(0));
    socket.on('connect', () => {
      const auth = withCredentials ? `Proxy-Authorization: Basic ${Buffer.from(credentials).toString('base64')}\r\n` : '';
      socket.write(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\n${auth}\r\n`);
    });
    socket.on('data', (chunk) => {
      received += chunk.toString();
      if (!received.includes('\r\n\r\n') && !received.includes('Established')) return;
      const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(received)?.[1] ?? 0);
      if (status !== 200) return done(status);
      if (received.includes('ping-through-tunnel')) return done(200, true);
      socket.write('ping-through-tunnel');
    });
    socket.on('close', () => done(Number(/^HTTP\/1\.1 (\d{3})/.exec(received)?.[1] ?? 0)));
  });
}

for (const host of process.argv.slice(2)) console.log(JSON.stringify(await tunnel(host)));
