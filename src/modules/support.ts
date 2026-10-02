import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { one,type Database } from '../db.js';
import { assert,event,page,uuid } from '../core.js';
import { authentication } from './auth.js';
import { accessOrder } from './orders.js';
export function supportRoutes(db:Database) {
  const r=Router();r.use(authentication(db));
  r.get('/threads',async(req,res)=>{const p=page(req.query);res.json({data:(await db.query('SELECT * FROM support_threads WHERE ($1 OR user_id=$2) ORDER BY created_at DESC LIMIT $3 OFFSET $4',[req.actor.role==='ADMIN',req.actor.id,p.limit,p.offset])).rows});});
  r.post('/threads',async(req,res)=>{
    const b=z.object({orderId:uuid.optional(),message:z.string().trim().min(1).max(4000)}).strict().parse(req.body);
    if(b.orderId)await accessOrder(db,b.orderId,req.actor);
    const id=randomUUID();await db.transaction(async tx=>{
      await tx.query('INSERT INTO support_threads(id,user_id,order_id) VALUES($1,$2,$3)',[id,req.actor.id,b.orderId??null]);
      await tx.query('INSERT INTO support_messages(id,thread_id,author_id,body) VALUES($1,$2,$3,$4)',[randomUUID(),id,req.actor.id,b.message]);
      await event(tx,'support.opened',{threadId:id},null,null,'ADMIN');
    });res.status(201).json({data:{id}});
  });
  r.get('/threads/:id/messages',async(req,res)=>{
    const id=uuid.parse(req.params.id),p=page(req.query),thread=await one(db,'SELECT * FROM support_threads WHERE id=$1 AND ($2 OR user_id=$3)',[id,req.actor.role==='ADMIN',req.actor.id]);assert(thread,404,'NOT_FOUND','Обращение не найдено');
    res.json({data:(await db.query('SELECT id,author_id,body,created_at FROM support_messages WHERE thread_id=$1 ORDER BY created_at,id LIMIT $2 OFFSET $3',[id,p.limit,p.offset])).rows});
  });
  r.post('/threads/:id/messages',async(req,res)=>{
    const id=uuid.parse(req.params.id),b=z.object({message:z.string().trim().min(1).max(4000)}).strict().parse(req.body);
    const message=await db.transaction(async tx=>{
      const thread=await one(tx,'SELECT * FROM support_threads WHERE id=$1 AND ($2 OR user_id=$3) FOR UPDATE',[id,req.actor.role==='ADMIN',req.actor.id]);assert(thread,404,'NOT_FOUND','Обращение не найдено');assert(thread.status==='OPEN',409,'THREAD_CLOSED','Обращение закрыто');
      const m=await one(tx,'INSERT INTO support_messages(id,thread_id,author_id,body) VALUES($1,$2,$3,$4) RETURNING *',[randomUUID(),id,req.actor.id,b.message]);
      await event(tx,'support.message',{threadId:id,messageId:m!.id},thread.user_id);await event(tx,'support.message',{threadId:id,messageId:m!.id},null,null,'ADMIN');return m;
    });res.status(201).json({data:message});
  });
  r.patch('/threads/:id',async(req,res)=>{
    assert(req.actor.role==='ADMIN',403,'FORBIDDEN','Требуется администратор');const b=z.object({status:z.enum(['OPEN','CLOSED'])}).strict().parse(req.body);
    const thread=await one(db,'UPDATE support_threads SET status=$2 WHERE id=$1 RETURNING *',[uuid.parse(req.params.id),b.status]);assert(thread,404,'NOT_FOUND','Обращение не найдено');res.json({data:thread});
  });return r;
}
