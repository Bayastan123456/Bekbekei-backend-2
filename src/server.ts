import 'dotenv/config';
import { createApp } from './app.js';
import { postgres } from './db.js';
import { config,assert } from './core.js';
import { startWorker } from './worker.js';
const cfg=config();assert(process.env.DATABASE_URL,500,'CONFIG','Задайте DATABASE_URL');
const db=postgres(process.env.DATABASE_URL);await db.query('SELECT 1');
const server=createApp(db,cfg).listen(Number(process.env.PORT??3000),process.env.HOST??'127.0.0.1',()=>cfg.logger({type:'server.started',port:Number(process.env.PORT??3000),testMode:true}));
const stopWorker=startWorker(db,cfg);
let stopping=false;
async function shutdown(){if(stopping)return;stopping=true;stopWorker();server.close();server.closeAllConnections();await db.close();process.exit(0);}
process.on('SIGINT',()=>void shutdown());process.on('SIGTERM',()=>void shutdown());
