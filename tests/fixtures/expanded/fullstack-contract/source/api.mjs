import http from 'node:http';
export function server(){return http.createServer((_req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({profile:{displayName:'Ada'}}));});}
