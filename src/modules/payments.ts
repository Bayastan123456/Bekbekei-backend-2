import { Router,type RequestHandler } from 'express';
import { randomUUID,createHmac } from 'node:crypto';
import { z } from 'zod';
import { one,type Database } from '../db.js';
import { assert,equal,event,sha,uuid,type Config } from '../core.js';
import { authentication,roles } from './auth.js';
import { accessOrder,cancelOrder,enqueueRefund,idempotencyKey,setStatus } from './orders.js';
export const paymentEventSchema=z.object({eventId:z.string().min(8).max(128),paymentId:uuid,status:z.enum(['PAID','FAILED']),amount:z.number().int().min(0)}).strict();
export async function processPaymentEvent(db:Database,b:z.infer<typeof paymentEventSchema>) {
  return db.transaction(async tx=>{
    const payment=await one(tx,'SELECT * FROM payments WHERE id=$1',[b.paymentId]);assert(payment,404,'NOT_FOUND','Платёж не найден');
    const order=(await one(tx,'SELECT * FROM orders WHERE id=$1 FOR UPDATE',[payment.order_id]))!;
    const previous=await one(tx,'SELECT * FROM payment_events WHERE provider_event_id=$1',[b.eventId]);
    const hash=sha(JSON.stringify(b));
    if(previous){assert(previous.payload_hash===hash,409,'EVENT_CONFLICT','Событие изменилось');return {duplicate:true};}
    assert(payment.amount===b.amount,422,'AMOUNT_MISMATCH','Сумма платежа не совпадает');
    await tx.query('INSERT INTO payment_events(provider_event_id,payment_id,payload_hash) VALUES($1,$2,$3)',[b.eventId,b.paymentId,hash]);
    const current=(await one(tx,'SELECT * FROM payments WHERE id=$1 FOR UPDATE',[payment.id]))!;
    if(current.status==='PAID')return {duplicate:true};
    if(b.status==='FAILED'){
      if(current.status==='PENDING')await tx.query("UPDATE payments SET status='FAILED' WHERE id=$1",[payment.id]);
      await event(tx,'payment.failed',{orderId:order.id,paymentId:payment.id},order.user_id);return {duplicate:false};
    }
    await tx.query("UPDATE payments SET status='PAID' WHERE id=$1",[payment.id]);
    // A late second successful attempt is refunded, never charged to the order twice.
    const alreadyPaid=order.payment_status!=='UNPAID';
    if(alreadyPaid||order.status==='CANCELLED'||order.status==='RETURNED') {
      await enqueueRefund(tx,{...order,payment_status:'PAID'},payment.amount);
      if(!alreadyPaid)await tx.query("UPDATE orders SET payment_status=CASE WHEN $2=0 THEN 'REFUNDED' ELSE 'REFUND_PENDING' END WHERE id=$1",[order.id,payment.amount]);
      return {duplicate:false,refundPending:true};
    }
    if(order.status==='AWAITING_PAYMENT'&&+new Date(order.expires_at)<=Date.now()) {
      await cancelOrder(tx,order,null);await enqueueRefund(tx,{...order,payment_status:'PAID'},payment.amount);
      await tx.query("UPDATE orders SET payment_status=CASE WHEN $2=0 THEN 'REFUNDED' ELSE 'REFUND_PENDING' END WHERE id=$1",[order.id,payment.amount]);return {refundPending:true};
    }
    assert(order.status==='AWAITING_PAYMENT',409,'INVALID_STATE','Заказ не ожидает оплату');
    await tx.query("UPDATE orders SET payment_status='PAID' WHERE id=$1",[order.id]);await setStatus(tx,order,'CONFIRMED',null);
    await event(tx,'payment.paid',{orderId:order.id,paymentId:payment.id},order.user_id);return {duplicate:false};
  });
}
export function webhookHandler(db:Database,cfg:Config):RequestHandler {
  return async(req,res)=>{
    assert(cfg.paymentProvider==='mock',503,'PAYMENTS_DISABLED','Платежи отключены');
    const raw=req.body as Buffer,signature=req.headers['x-payment-signature'];
    assert(Buffer.isBuffer(raw)&&typeof signature==='string',400,'INVALID_WEBHOOK','Ожидается подписанный JSON');
    const expected=createHmac('sha256',cfg.webhookSecret).update(raw).digest('hex');
    assert(equal(signature,expected),401,'INVALID_SIGNATURE','Подпись не совпадает');
    let body;try{body=JSON.parse(raw.toString());}catch{assert(false,400,'INVALID_JSON','Некорректный JSON');}
    const result=await processPaymentEvent(db,paymentEventSchema.parse(body));res.json({data:result});
  };
}
export function paymentRoutes(db:Database,cfg:Config) {
  const r=Router();r.use((req,_res,next)=>req.path.startsWith('/payments/')||/^\/orders\/[^/]+\/payments$/.test(req.path)?next():next('router'));r.use(authentication(db));
  r.post('/orders/:id/payments',roles('CUSTOMER'),async(req,res)=>{
    assert(cfg.paymentProvider==='mock',503,'PAYMENTS_DISABLED','Платежи отключены');
    const id=uuid.parse(req.params.id),key=idempotencyKey(req.headers['idempotency-key']);
    const payment=await db.transaction(async tx=>{
      const o=await accessOrder(tx,id,req.actor,true);
      const existing=await one(tx,'SELECT * FROM payments WHERE order_id=$1 AND idempotency_key=$2',[id,key]);if(existing)return existing;
      assert(o.status==='AWAITING_PAYMENT'&&o.payment_method==='QR'&&+new Date(o.expires_at)>Date.now(),409,'NOT_AWAITING_PAYMENT','Заказ не ожидает оплату');
      const pending=await one(tx,"SELECT * FROM payments WHERE order_id=$1 AND status='PENDING'",[id]);if(pending)return pending;
      return (await one(tx,"INSERT INTO payments(id,order_id,amount,status,provider,idempotency_key) VALUES($1,$2,$3,'PENDING','mock',$4) RETURNING *",[randomUUID(),id,o.total,key]))!;
    });
    res.status(201).json({data:{...payment,testMode:true,qrPayload:`bekbekei-test://payment/${payment.id}`,message:'Тестовая QR-оплата. Не является банковским QR-кодом.'}});
  });
  r.get('/payments/:id',async(req,res)=>{
    const p=await one(db,'SELECT * FROM payments WHERE id=$1',[uuid.parse(req.params.id)]);assert(p,404,'NOT_FOUND','Платёж не найден');await accessOrder(db,p.order_id,req.actor);res.json({data:p});
  });
  r.post('/payments/:id/mock-confirm',roles('ADMIN'),async(req,res)=>{
    assert(cfg.env!=='production'&&cfg.paymentProvider==='mock',404,'NOT_FOUND','Недоступно');
    const p=await one(db,'SELECT * FROM payments WHERE id=$1',[uuid.parse(req.params.id)]);assert(p,404,'NOT_FOUND','Платёж не найден');
    const b=z.object({status:z.enum(['PAID','FAILED']).default('PAID')}).strict().parse(req.body??{});
    const result=await processPaymentEvent(db,{eventId:`admin-${randomUUID()}`,paymentId:p.id,status:b.status,amount:p.amount});
    await db.query('INSERT INTO audit_logs(actor_id,action,entity_id) VALUES($1,$2,$3)',[req.actor.id,'MOCK_PAYMENT_CONFIRM',p.id]);res.json({data:result});
  });return r;
}
