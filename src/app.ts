import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import swaggerUi from 'swagger-ui-express';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ZodError } from 'zod';
import { type Database } from './db.js';
import { AppError,type Config } from './core.js';
import { authRoutes } from './modules/auth.js';
import { catalogRoutes,userRoutes } from './modules/catalog.js';
import { orderRoutes } from './modules/orders.js';
import { pickingRoutes,deliveryRoutes,replacementRoutes,shiftRoutes } from './modules/fulfillment.js';
import { paymentRoutes,webhookHandler } from './modules/payments.js';
import { supportRoutes } from './modules/support.js';
import { adminRoutes } from './modules/admin.js';
import { eventRoutes } from './modules/events.js';

export function createApp(db:Database,cfg:Config) {
  const app=express();app.disable('x-powered-by');
  app.use(helmet());app.use(cors({origin:(origin,callback)=>callback(null,!origin||cfg.corsOrigins.includes(origin)),credentials:false}));
  app.use((req,res,next)=>{res.set('X-Request-Id',randomUUID());next();});
  app.use(rateLimit({windowMs:60_000,limit:300,standardHeaders:'draft-8',legacyHeaders:false,message:{error:{code:'RATE_LIMIT',message:'Слишком много запросов'}}}));
  app.get('/health',(_req,res)=>res.json({data:{status:'ok',service:'bekbekei-backend'}}));
  app.get('/ready',async(_req,res)=>{await db.query('SELECT 1');res.json({data:{status:'ready'}});});
  app.post('/api/v1/webhooks/payments/mock',express.raw({type:'application/json',limit:'32kb'}),webhookHandler(db,cfg));
  app.use(express.json({limit:'64kb'}));
  app.use('/api/v1/auth',authRoutes(db,cfg));
  app.use('/api/v1',catalogRoutes(db),userRoutes(db),orderRoutes(db,cfg.paymentProvider),replacementRoutes(db),paymentRoutes(db,cfg));
  app.use('/api/v1/picking',pickingRoutes(db));app.use('/api/v1/delivery',deliveryRoutes(db));app.use('/api/v1/courier',shiftRoutes(db));
  app.use('/api/v1/support',supportRoutes(db));app.use('/api/v1/admin',adminRoutes(db));app.use('/api/v1/events',eventRoutes(db));
  // Routers with global auth middleware must only be mounted under their own namespaces.
  const spec=JSON.parse(readFileSync(resolve('docs/openapi.json'),'utf8'));
  app.get('/openapi.json',(_req,res)=>res.json(spec));
  app.use('/docs',swaggerUi.serve,swaggerUi.setup(spec,{swaggerOptions:{persistAuthorization:false}}));
  app.use('/admin',express.static(resolve('public'),{index:'index.html'}));
  app.use((_req,_res,next)=>next(new AppError(404,'NOT_FOUND','Маршрут не найден')));
  app.use((error:any,_req:express.Request,res:express.Response,_next:express.NextFunction)=>{
    const requestId=res.getHeader('X-Request-Id');
    if(error instanceof ZodError){res.status(422).json({error:{code:'VALIDATION_ERROR',message:'Проверьте входящие данные',details:error.issues.map(i=>({path:i.path,message:i.message})),requestId}});return;}
    if(error instanceof AppError){res.status(error.status).json({error:{code:error.code,message:error.message,details:error.details,requestId}});return;}
    if(error?.type==='entity.parse.failed'){res.status(400).json({error:{code:'INVALID_JSON',message:'Некорректный JSON',requestId}});return;}
    if(error?.type==='entity.too.large'){res.status(413).json({error:{code:'BODY_TOO_LARGE',message:'Слишком большой запрос',requestId}});return;}
    if(error?.code==='23505'){res.status(409).json({error:{code:'CONFLICT',message:'Такая запись уже существует',requestId}});return;}
    if(error?.code==='23503'){res.status(422).json({error:{code:'INVALID_REFERENCE',message:'Связанная запись не найдена',requestId}});return;}
    cfg.logger({type:'request.error',requestId,message:String(error)});res.status(500).json({error:{code:'INTERNAL_ERROR',message:'Внутренняя ошибка сервера',requestId}});
  });return app;
}
