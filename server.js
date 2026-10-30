const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PORT = Number(process.env.PORT) || 8000;
const APP_FILE = 'index.html';
const appPath = path.join(__dirname, 'public', APP_FILE);

const server = http.createServer((request, response) => {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD' });
    response.end('Method not allowed');
    return;
  }

  let requestedPath;
  try {
    requestedPath = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  } catch {
    response.writeHead(400);
    response.end('Invalid request path');
    return;
  }

  if (requestedPath !== '/' && requestedPath !== `/${APP_FILE}`) {
    response.writeHead(404);
    response.end('Not found');
    return;
  }

  fs.readFile(appPath, (error, html) => {
    if (error) {
      console.error('Unable to read booking page:', error);
      response.writeHead(500);
      response.end('Unable to read booking page');
      return;
    }

    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store'
    });
    response.end(request.method === 'HEAD' ? undefined : html);
  });
});


server.on('error', error => {
  console.error('Unable to start local web server:', error);
  process.exitCode = 1;
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Booking page: http://127.0.0.1:${PORT}/`);
});
