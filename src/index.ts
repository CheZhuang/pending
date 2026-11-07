import { createServer } from 'node:http';

const port = Number(process.env.PORT ?? 3000);

const server = createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ name: 'Agentree API', status: 'ok' }));
});

server.listen(port, () => {
  console.log(`Agentree API listening on http://localhost:${port}`);
});
