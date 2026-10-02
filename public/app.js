// Tokens stay in memory, never in localStorage or URL parameters.
let accessToken=null,refreshToken=null,resource='summary';
const $=id=>document.getElementById(id);
const templates={
 'Новый товар':{method:'POST',path:'/api/v1/admin/products',body:{categoryId:'UUID категории',name:{ru:'Название'},unit:'1 шт.',nutrition:{calories:100},isNew:true}},
 'Изменить товар':{method:'PUT',path:'/api/v1/admin/products/UUID',body:{categoryId:'UUID категории',name:{ru:'Название'},unit:'1 шт.',active:true}},
 'Остаток и цена':{method:'PUT',path:'/api/v1/admin/inventory',body:{storeId:'UUID магазина',productId:'UUID товара',price:13000,stock:100}},
 'Новая категория':{method:'POST',path:'/api/v1/admin/categories',body:{name:{ru:'Овощи'},sort:1}},
 'Новый сотрудник':{method:'POST',path:'/api/v1/admin/staff',body:{phone:'+996700000002',password:'Введите свой пароль от 12 символов',role:'PICKER',firstName:'Имя',storeIds:['UUID магазина']}},
 'Изменить сотрудника':{method:'PATCH',path:'/api/v1/admin/staff/UUID',body:{active:false}},
 'Промокод':{method:'POST',path:'/api/v1/admin/promotions',body:{code:'SALE10',kind:'PERCENT',value:10,startsAt:new Date().toISOString(),endsAt:new Date(Date.now()+30*86400000).toISOString(),usageLimit:100}},
 'Подарок по промокоду':{method:'POST',path:'/api/v1/admin/promotions',body:{code:'GIFT',kind:'GIFT',giftProductId:'UUID подарка',triggerProductIds:['UUID товара-условия'],startsAt:new Date().toISOString(),endsAt:new Date(Date.now()+30*86400000).toISOString(),usageLimit:100}},
 'Баннер':{method:'POST',path:'/api/v1/admin/content',body:{kind:'BANNER',title:{ru:'Новая акция'},body:{ru:'Описание'},sort:1}},
 'Магазин':{method:'POST',path:'/api/v1/admin/stores',body:{name:'Новый магазин',address:'Бишкек, адрес',latitude:42.8746,longitude:74.5698,radiusKm:5,deliveryFee:10000,opensAt:'09:00',closesAt:'01:00'}},
 'Ответ поддержке':{method:'POST',path:'/api/v1/support/threads/UUID/messages',body:{message:'Здравствуйте!'}},
 'Закрыть обращение':{method:'PATCH',path:'/api/v1/support/threads/UUID',body:{status:'CLOSED'}}
};
async function api(path,options={},retry=true){
 const headers={'Content-Type':'application/json',...(accessToken?{Authorization:`Bearer ${accessToken}`}:{})};
 const res=await fetch(path,{...options,headers:{...headers,...options.headers}});
 if(res.status===401&&refreshToken&&retry){const r=await fetch('/api/v1/auth/refresh',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({refreshToken})});if(r.ok){const j=await r.json();accessToken=j.data.accessToken;refreshToken=j.data.refreshToken;return api(path,options,false);}logout();}
 const body=res.status===204?{data:null}:await res.json();if(!res.ok)throw new Error(body.error?.message??`HTTP ${res.status}`);return body.data;
}
function message(text){$('message').textContent=text;}
function logout(){accessToken=refreshToken=null;$('dashboard').hidden=true;$('login').hidden=false;$('logout').hidden=true;$('login-form').reset();}
function cell(value){const td=document.createElement('td');if(value&&typeof value==='object'){const pre=document.createElement('code');pre.textContent=JSON.stringify(value);td.append(pre);}else td.textContent=value??'—';return td;}
async function action(path,body={}){try{await api(path,{method:'POST',body:JSON.stringify(body)});await load();message('Готово');}catch(e){message(e.message);}}
function table(rows){
 const wrap=document.createElement('div');wrap.className='table-wrap';if(!rows.length){wrap.textContent='Пока нет записей';return wrap;}
 const table=document.createElement('table'),head=document.createElement('tr');const keys=Object.keys(rows[0]).filter(k=>!['request_hash','idempotency_key'].includes(k));
 for(const k of keys){const th=document.createElement('th');th.textContent=k;head.append(th);}const th=document.createElement('th');th.textContent='Действия';head.append(th);table.append(head);
 for(const row of rows){const tr=document.createElement('tr');for(const k of keys)tr.append(cell(row[k]));const actions=document.createElement('td');actions.className='actions';
  const add=(label,fn)=>{const b=document.createElement('button');b.textContent=label;b.onclick=fn;actions.append(b);};
  add('ID',()=>{navigator.clipboard?.writeText(String(row.id??row.code??row.product_id??''));message('Идентификатор скопирован');});
  if(resource==='orders'){add('Детали',async()=>{try{$('response').textContent=JSON.stringify(await api(`/api/v1/admin/orders/${row.id}`),null,2);}catch(e){message(e.message);}});if(['AWAITING_PAYMENT','CONFIRMED','PICKING'].includes(row.status))add('Отменить',()=>{if(confirm('Отменить этот заказ?'))void action(`/api/v1/admin/orders/${row.id}/cancel`);});if(row.status==='DELIVERING')add('Разрешить возврат',()=>{if(confirm('Разрешить возврат в магазин?'))void action(`/api/v1/admin/orders/${row.id}/authorize-return`);});}
  if(resource==='payments'&&row.status==='PENDING')add('Тест: оплачено',()=>action(`/api/v1/payments/${row.id}/mock-confirm`));
  if(resource==='jobs'&&!row.completed_at)add('Повторить',()=>action(`/api/v1/admin/jobs/${row.id}/retry`));
  if(resource==='support')add('Сообщения',async()=>{try{$('response').textContent=JSON.stringify(await api(`/api/v1/support/threads/${row.id}/messages`),null,2);}catch(e){message(e.message);}});
  tr.append(actions);table.append(tr);
 }wrap.append(table);return wrap;
}
async function load(){try{message('');const path=resource==='support'?'/api/v1/support/threads':`/api/v1/admin/${resource}`;const data=await api(path);$('result').replaceChildren();if(Array.isArray(data))$('result').append(table(data));else{for(const [key,value] of Object.entries(data)){const h=document.createElement('h2');h.textContent=key;$('result').append(h,Array.isArray(value)?table(value):cell(value));}}document.querySelectorAll('[data-resource]').forEach(b=>b.classList.toggle('active',b.dataset.resource===resource));}catch(e){message(e.message);}}
$('login-form').onsubmit=async e=>{e.preventDefault();try{const data=new FormData(e.target);const result=await api('/api/v1/auth/staff/login',{method:'POST',body:JSON.stringify({phone:data.get('phone'),password:data.get('password')})});if(result.user.role!=='ADMIN'){await fetch('/api/v1/auth/logout',{method:'POST',headers:{Authorization:`Bearer ${result.accessToken}`}});throw new Error('Панель доступна только администратору');}accessToken=result.accessToken;refreshToken=result.refreshToken;e.target.reset();$('login').hidden=true;$('dashboard').hidden=false;$('logout').hidden=false;await load();}catch(e){message(e.message);}};
$('logout').onclick=async()=>{try{await api('/api/v1/auth/logout',{method:'POST'});}finally{logout();}};$('refresh').onclick=load;
$('tabs').onclick=e=>{if(e.target.dataset.resource){resource=e.target.dataset.resource;void load();}};
for(const label of Object.keys(templates)){const option=document.createElement('option');option.textContent=label;$('template').append(option);}
function template(){const t=templates[$('template').value];$('method').value=t.method;$('path').value=t.path;$('body').value=JSON.stringify(t.body,null,2);}$('template').onchange=template;template();
$('submit').onclick=async()=>{const path=$('path').value;try{if(!/^\/api\/v1\/(admin|support)\//.test(path))throw new Error('Разрешены только пути admin и support');const body=JSON.parse($('body').value);const result=await api(path,{method:$('method').value,body:JSON.stringify(body)});$('response').textContent=JSON.stringify(result??{ok:true},null,2);await load();message('Сохранено');}catch(e){message(e.message);}};
