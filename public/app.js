// Tokens stay in memory, never in localStorage or URL parameters.
let accessToken = null;
let refreshToken = null;
let resource = 'summary';
let editing = null; // {resource, id} while a create-form is prefilled for an update

const $ = id => document.getElementById(id);

// ---------- formatting helpers ----------
const money = kopecks =>
  kopecks == null ? '—' : (kopecks / 100).toLocaleString('ru-RU', { minimumFractionDigits: 2 }) + ' сом';
const dateTime = iso => (iso ? new Date(iso).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' }) : '—');
const toLocalInput = iso => (iso ? new Date(iso).toISOString().slice(0, 16) : '');
const yesNo = value => (value ? 'Да' : 'Нет');
const localizedText = value => (value && typeof value === 'object' ? value.ru ?? Object.values(value)[0] ?? '—' : value ?? '—');
const short = id => (id ? String(id).slice(0, 8) + '…' : '—');

const ORDER_STATUS = {
  AWAITING_PAYMENT: 'Ожидает оплаты',
  CONFIRMED: 'Подтверждён',
  PICKING: 'Собирается',
  READY: 'Готов к выдаче',
  DELIVERING: 'В доставке',
  DELIVERED: 'Доставлен',
  CANCELLED: 'Отменён',
  RETURNING: 'Возвращается',
  RETURNED: 'Возвращён',
};
const PAYMENT_METHOD = { CASH: 'Наличные', QR: 'QR-оплата' };
const PAYMENT_STATUS = { UNPAID: 'Не оплачен', PAID: 'Оплачен', REFUND_PENDING: 'Возврат ожидает', REFUNDED: 'Возвращён' };
const PAYMENT_ROW_STATUS = { PENDING: 'Ожидает оплаты', PAID: 'Оплачен', FAILED: 'Не удался', EXPIRED: 'Истёк' };
const REFUND_STATUS = { PENDING: 'В обработке', COMPLETED: 'Выполнен', FAILED: 'Не удался' };
const ROLE_LABEL = { CUSTOMER: 'Клиент', PICKER: 'Сборщик', COURIER: 'Курьер', ADMIN: 'Администратор' };
const PROMO_KIND = { PERCENT: 'Скидка, %', FIXED: 'Скидка, сом', FREE_DELIVERY: 'Бесплатная доставка', GIFT: 'Подарок' };
const CONTENT_KIND = { BANNER: 'Баннер', STORY: 'История', NOTICE: 'Уведомление', DOCUMENT: 'Документ', COLLECTION: 'Подборка' };
const SUPPORT_STATUS = { OPEN: 'Открыто', CLOSED: 'Закрыто' };
const badgeClass = status =>
  ({
    DELIVERED: 'good', CONFIRMED: 'good', PAID: 'good', READY: 'good', COMPLETED: 'good', OPEN: 'good',
    CANCELLED: 'bad', RETURNED: 'bad', FAILED: 'bad', EXPIRED: 'bad', CLOSED: 'bad',
  })[status] ?? 'neutral';
function badge(text, status) {
  const span = document.createElement('span');
  span.className = `badge badge-${badgeClass(status)}`;
  span.textContent = text;
  return span;
}

// ---------- API ----------
async function api(path, options = {}, retry = true) {
  const headers = { 'Content-Type': 'application/json', ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}) };
  const res = await fetch(path, { ...options, headers: { ...headers, ...options.headers } });
  if (res.status === 401 && refreshToken && retry) {
    const r = await fetch('/api/v1/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });
    if (r.ok) {
      const j = await r.json();
      accessToken = j.data.accessToken;
      refreshToken = j.data.refreshToken;
      return api(path, options, false);
    }
    logout();
  }
  const body = res.status === 204 ? { data: null } : await res.json();
  if (!res.ok) throw new Error(body.error?.message ?? `HTTP ${res.status}`);
  return body.data;
}
let cache = { stores: [], categories: [], products: [] };
async function loadLookups() {
  [cache.stores, cache.categories, cache.products] = await Promise.all([
    api('/api/v1/admin/stores'),
    api('/api/v1/admin/categories'),
    api('/api/v1/admin/products'),
  ]);
}

function message(text) {
  $('message').textContent = text;
}
function logout() {
  accessToken = refreshToken = null;
  $('shell').hidden = true;
  $('login').hidden = false;
  $('logout').hidden = true;
  $('login-form').reset();
}
async function action(path, body = {}, confirmText) {
  if (confirmText && !confirm(confirmText)) return;
  try {
    await api(path, { method: 'POST', body: JSON.stringify(body) });
    message('Готово');
    await load();
  } catch (e) {
    message(e.message);
  }
}

// ---------- generic form rendering ----------
function getPath(obj, path) {
  return path.split('.').reduce((o, k) => o?.[k], obj);
}
const toSnake = key => key.replace(/[A-Z]/g, m => '_' + m.toLowerCase());
// Form field keys follow the request body (camelCase); API responses are snake_case DB rows.
// Try the field key as-is first (matches localized paths like "name.ru"), then its snake_case form.
function rowValue(row, path) {
  const direct = getPath(row, path);
  return direct !== undefined ? direct : getPath(row, path.split('.').map(toSnake).join('.'));
}
function setPath(obj, path, value) {
  const parts = path.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) cur = cur[parts[i]] ??= {};
  cur[parts.at(-1)] = value;
}
function buildField(f, row) {
  const wrap = document.createElement('label');
  wrap.textContent = f.label;
  let input;
  if (f.type === 'textarea') {
    input = document.createElement('textarea');
    input.rows = 3;
  } else if (f.type === 'select' || f.type === 'multiselect') {
    input = document.createElement('select');
    if (f.type === 'multiselect') input.multiple = true;
    for (const opt of f.options ?? []) {
      const o = document.createElement('option');
      o.value = opt.value;
      o.textContent = opt.label;
      input.append(o);
    }
  } else {
    input = document.createElement('input');
    input.type = { money: 'number', number: 'number' }[f.type] ?? f.type ?? 'text';
    if (f.type === 'money') input.step = '0.01';
    if (f.type === 'number') input.step = f.step ?? '1';
  }
  input.name = f.key;
  if (f.required) input.required = true;
  const value = row ? rowValue(row, f.key) : undefined;
  if (f.type === 'checkbox') input.checked = row ? !!value : f.defaultChecked === true;
  else if (value !== undefined && value !== null) {
    if (f.type === 'money') input.value = (value / 100).toFixed(2);
    else if (f.type === 'datetime-local') input.value = toLocalInput(value);
    else if (f.type === 'multiselect' && Array.isArray(value)) for (const o of input.options) o.selected = value.includes(o.value);
    else input.value = value;
  }
  wrap.append(input);
  if (f.hint) {
    const small = document.createElement('small');
    small.textContent = f.hint;
    wrap.append(small);
  }
  return wrap;
}
function collectForm(form, fields) {
  const body = {};
  for (const f of fields) {
    const input = form.elements.namedItem(f.key);
    if (!input) continue;
    if (f.type === 'checkbox') {
      setPath(body, f.key, input.checked);
      continue;
    }
    if (f.type === 'multiselect') {
      setPath(body, f.key, [...input.selectedOptions].map(o => o.value));
      continue;
    }
    if (input.value === '') {
      if (f.required) throw new Error(`Заполните поле «${f.label}»`);
      continue;
    }
    let value = input.value;
    if (f.type === 'number') value = Number(value);
    else if (f.type === 'money') value = Math.round(Number(value) * 100);
    else if (f.type === 'datetime-local') value = new Date(value).toISOString();
    setPath(body, f.key, value);
  }
  return body;
}
function renderForm(title, fields, row, onSubmit, onCancel) {
  const area = $('form-area');
  area.replaceChildren();
  const section = document.createElement('section');
  section.className = 'editor';
  const h2 = document.createElement('h2');
  h2.textContent = title;
  const form = document.createElement('form');
  for (const f of fields) form.append(buildField(f, row));
  const actions = document.createElement('div');
  actions.className = 'form-actions';
  const submit = document.createElement('button');
  submit.textContent = row ? 'Сохранить изменения' : 'Создать';
  actions.append(submit);
  if (onCancel) {
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'secondary';
    cancel.textContent = 'Отмена';
    cancel.onclick = onCancel;
    actions.append(cancel);
  }
  form.append(actions);
  form.onsubmit = async e => {
    e.preventDefault();
    try {
      const body = collectForm(form, fields);
      await onSubmit(body);
    } catch (e) {
      message(e.message);
    }
  };
  section.append(h2, form);
  area.append(section);
}
function clearForm() {
  $('form-area').replaceChildren();
  editing = null;
}

// ---------- resource table rendering ----------
function cellNode(render, row) {
  const td = document.createElement('td');
  const value = render(row);
  if (value instanceof Node) td.append(value);
  else td.textContent = value ?? '—';
  return td;
}
function table(rows, columns, buildActions) {
  const wrap = document.createElement('div');
  wrap.className = 'table-wrap';
  if (!rows.length) {
    wrap.textContent = 'Пока нет записей';
    return wrap;
  }
  const tableEl = document.createElement('table');
  const head = document.createElement('tr');
  for (const c of columns) {
    const th = document.createElement('th');
    th.textContent = c.label;
    head.append(th);
  }
  const actionsHead = document.createElement('th');
  actionsHead.textContent = 'Действия';
  head.append(actionsHead);
  tableEl.append(head);
  for (const row of rows) {
    const tr = document.createElement('tr');
    for (const c of columns) tr.append(cellNode(c.render, row));
    const actionsCell = document.createElement('td');
    actionsCell.className = 'actions';
    for (const a of buildActions(row)) {
      const b = document.createElement('button');
      b.textContent = a.label;
      b.onclick = a.onClick;
      actionsCell.append(b);
    }
    tr.append(actionsCell);
    tableEl.append(tr);
  }
  wrap.append(tableEl);
  return wrap;
}

// ---------- per-resource definitions ----------
function storeOptions() {
  return cache.stores.map(s => ({ value: s.id, label: s.name }));
}
function categoryOptions() {
  return cache.categories.map(c => ({ value: c.id, label: localizedText(c.name) }));
}
function productOptions() {
  return cache.products.map(p => ({ value: p.id, label: localizedText(p.name) }));
}
function storeName(id) {
  return cache.stores.find(s => s.id === id)?.name ?? short(id);
}
function categoryName(id) {
  return localizedText(cache.categories.find(c => c.id === id)?.name) ?? short(id);
}

const STORE_FIELDS = () => [
  { key: 'name', label: 'Название', type: 'text', required: true },
  { key: 'address', label: 'Адрес', type: 'text', required: true },
  { key: 'latitude', label: 'Широта', type: 'number', step: '0.0001', required: true },
  { key: 'longitude', label: 'Долгота', type: 'number', step: '0.0001', required: true },
  { key: 'radiusKm', label: 'Радиус доставки, км', type: 'number', step: '0.1', required: true },
  { key: 'deliveryFee', label: 'Стоимость доставки, сом', type: 'money', required: true },
  { key: 'minimumOrder', label: 'Минимальный заказ, сом', type: 'money' },
  { key: 'opensAt', label: 'Время открытия', type: 'time', required: true },
  { key: 'closesAt', label: 'Время закрытия', type: 'time', required: true },
  { key: 'active', label: 'Магазин активен', type: 'checkbox', defaultChecked: true },
];
const CATEGORY_FIELDS = () => [
  { key: 'name.ru', label: 'Название (рус.)', type: 'text', required: true },
  { key: 'name.ky', label: 'Название (кырг.)', type: 'text' },
  { key: 'name.en', label: 'Название (англ.)', type: 'text' },
  { key: 'sort', label: 'Порядок сортировки', type: 'number' },
];
const PRODUCT_FIELDS = () => [
  { key: 'categoryId', label: 'Категория', type: 'select', required: true, options: categoryOptions() },
  { key: 'name.ru', label: 'Название (рус.)', type: 'text', required: true },
  { key: 'name.ky', label: 'Название (кырг.)', type: 'text' },
  { key: 'name.en', label: 'Название (англ.)', type: 'text' },
  { key: 'unit', label: 'Единица продажи (например, «1 шт.»)', type: 'text', required: true },
  { key: 'description.ru', label: 'Описание (рус.)', type: 'textarea' },
  { key: 'composition.ru', label: 'Состав (рус.)', type: 'textarea' },
  { key: 'nutrition.calories', label: 'Калорийность, ккал', type: 'number' },
  { key: 'nutrition.protein', label: 'Белки, г', type: 'number' },
  { key: 'nutrition.fat', label: 'Жиры, г', type: 'number' },
  { key: 'nutrition.carbohydrates', label: 'Углеводы, г', type: 'number' },
  { key: 'imageUrl', label: 'Ссылка на изображение (https://…)', type: 'url' },
  { key: 'isNew', label: 'Пометить «Новинка»', type: 'checkbox' },
  { key: 'ageRestricted', label: 'Товар 18+', type: 'checkbox' },
  { key: 'active', label: 'В продаже', type: 'checkbox', defaultChecked: true },
];
const INVENTORY_FIELDS = () => [
  { key: 'storeId', label: 'Магазин', type: 'select', required: true, options: storeOptions() },
  { key: 'productId', label: 'Товар', type: 'select', required: true, options: productOptions() },
  { key: 'price', label: 'Цена, сом', type: 'money', required: true },
  { key: 'stock', label: 'Остаток на складе, шт.', type: 'number', required: true },
];
const STAFF_CREATE_FIELDS = () => [
  { key: 'phone', label: 'Телефон (+996…)', type: 'tel', required: true },
  { key: 'password', label: 'Пароль (от 12 символов)', type: 'password', required: true },
  {
    key: 'role',
    label: 'Роль',
    type: 'select',
    required: true,
    options: [
      { value: 'PICKER', label: 'Сборщик' },
      { value: 'COURIER', label: 'Курьер' },
      { value: 'ADMIN', label: 'Администратор' },
    ],
  },
  { key: 'firstName', label: 'Имя', type: 'text', required: true },
  { key: 'lastName', label: 'Фамилия', type: 'text' },
  { key: 'storeIds', label: 'Магазины', type: 'multiselect', required: true, options: storeOptions() },
];
const STAFF_UPDATE_FIELDS = () => [
  { key: 'active', label: 'Сотрудник работает', type: 'checkbox' },
  { key: 'password', label: 'Новый пароль (оставьте пустым, если не меняется)', type: 'password' },
  { key: 'storeIds', label: 'Магазины', type: 'multiselect', options: storeOptions() },
];
const PROMOTION_FIELDS = () => [
  { key: 'code', label: 'Код промокода', type: 'text', required: true },
  {
    key: 'kind',
    label: 'Тип акции',
    type: 'select',
    required: true,
    options: Object.entries(PROMO_KIND).map(([value, label]) => ({ value, label })),
  },
  { key: 'value', label: 'Значение', type: 'number', hint: 'Процент (0–100) для скидки % или тыйын для фиксированной скидки' },
  { key: 'minimumOrder', label: 'Минимальная сумма заказа, сом', type: 'money' },
  { key: 'startsAt', label: 'Начало действия', type: 'datetime-local', required: true },
  { key: 'endsAt', label: 'Окончание действия', type: 'datetime-local', required: true },
  { key: 'usageLimit', label: 'Лимит использований', type: 'number', required: true },
  { key: 'giftProductId', label: 'Товар-подарок (только для типа «Подарок»)', type: 'select', options: [{ value: '', label: '—' }, ...productOptions()] },
  { key: 'triggerProductIds', label: 'Товары-условия (только для типа «Подарок»)', type: 'multiselect', options: productOptions() },
];
const CONTENT_FIELDS = () => [
  {
    key: 'kind',
    label: 'Тип материала',
    type: 'select',
    required: true,
    options: Object.entries(CONTENT_KIND).map(([value, label]) => ({ value, label })),
  },
  { key: 'title.ru', label: 'Заголовок (рус.)', type: 'text', required: true },
  { key: 'title.ky', label: 'Заголовок (кырг.)', type: 'text' },
  { key: 'title.en', label: 'Заголовок (англ.)', type: 'text' },
  { key: 'body.ru', label: 'Текст (рус.)', type: 'textarea' },
  { key: 'imageUrl', label: 'Ссылка на изображение (https://…)', type: 'url' },
  { key: 'productIds', label: 'Связанные товары', type: 'multiselect', options: productOptions() },
  { key: 'active', label: 'Показывать клиентам', type: 'checkbox', defaultChecked: true },
  { key: 'sort', label: 'Порядок сортировки', type: 'number' },
];

const RESOURCES = {
  summary: { label: 'Обзор' },
  orders: {
    columns: [
      { label: '№', render: r => r.number },
      { label: 'Статус', render: r => badge(ORDER_STATUS[r.status] ?? r.status, r.status) },
      { label: 'Оплата', render: r => `${PAYMENT_METHOD[r.payment_method] ?? r.payment_method} · ${PAYMENT_STATUS[r.payment_status] ?? r.payment_status}` },
      { label: 'Сумма', render: r => money(r.total) },
      { label: 'Создан', render: r => dateTime(r.created_at) },
    ],
    actions(row) {
      const list = [
        { label: 'Детали', onClick: () => showOrderDetail(row.id) },
      ];
      if (['AWAITING_PAYMENT', 'CONFIRMED', 'PICKING'].includes(row.status))
        list.push({ label: 'Отменить', onClick: () => action(`/api/v1/admin/orders/${row.id}/cancel`, {}, 'Отменить этот заказ?') });
      if (row.status === 'DELIVERING')
        list.push({ label: 'Разрешить возврат', onClick: () => action(`/api/v1/admin/orders/${row.id}/authorize-return`, {}, 'Разрешить возврат в магазин?') });
      return list;
    },
  },
  products: {
    columns: [
      { label: 'Название', render: r => localizedText(r.name) },
      { label: 'Категория', render: r => categoryName(r.category_id) },
      { label: 'Единица', render: r => r.unit },
      { label: 'Новинка', render: r => yesNo(r.is_new) },
      { label: '18+', render: r => yesNo(r.age_restricted) },
      { label: 'В продаже', render: r => badge(yesNo(r.active), r.active ? 'DELIVERED' : 'CANCELLED') },
    ],
    actions: row => [{ label: 'Редактировать', onClick: () => editResource('products', row.id, PRODUCT_FIELDS, row, 'Товар') }],
    create: { title: 'Новый товар', fields: PRODUCT_FIELDS, path: '/api/v1/admin/products' },
  },
  inventory: {
    columns: [
      { label: 'Магазин', render: r => storeName(r.store_id) },
      { label: 'Товар', render: r => localizedText(r.name) },
      { label: 'Цена', render: r => money(r.price) },
      { label: 'Остаток', render: r => r.stock },
      { label: 'Зарезервировано', render: r => r.reserved },
      { label: 'Доступно', render: r => r.stock - r.reserved },
    ],
    actions: row => [
      {
        label: 'Изменить',
        onClick: () => renderForm('Остаток и цена', INVENTORY_FIELDS(), { ...row, storeId: row.store_id, productId: row.product_id }, async body => {
          await api('/api/v1/admin/inventory', { method: 'PUT', body: JSON.stringify(body) });
          message('Сохранено');
          clearForm();
          await load();
        }, clearForm),
      },
    ],
    create: { title: 'Остаток и цена', fields: INVENTORY_FIELDS, method: 'PUT', path: '/api/v1/admin/inventory', noId: true },
  },
  categories: {
    columns: [
      { label: 'Название', render: r => localizedText(r.name) },
      { label: 'Порядок', render: r => r.sort },
    ],
    actions: row => [{ label: 'Редактировать', onClick: () => editResource('categories', row.id, CATEGORY_FIELDS, row, 'Категория') }],
    create: { title: 'Новая категория', fields: CATEGORY_FIELDS, path: '/api/v1/admin/categories' },
  },
  stores: {
    columns: [
      { label: 'Название', render: r => r.name },
      { label: 'Адрес', render: r => r.address },
      { label: 'Радиус доставки', render: r => `${Number(r.radius_km)} км` },
      { label: 'Доставка', render: r => money(r.delivery_fee) },
      { label: 'Мин. заказ', render: r => money(r.minimum_order) },
      { label: 'Часы работы', render: r => `${r.opens_at.slice(0, 5)}–${r.closes_at.slice(0, 5)}` },
      { label: 'Активен', render: r => badge(yesNo(r.active), r.active ? 'DELIVERED' : 'CANCELLED') },
    ],
    actions: row => [{ label: 'Редактировать', onClick: () => editResource('stores', row.id, STORE_FIELDS, row, 'Магазин') }],
    create: { title: 'Новый магазин', fields: STORE_FIELDS, path: '/api/v1/admin/stores' },
  },
  staff: {
    columns: [
      { label: 'Телефон', render: r => r.phone },
      { label: 'Имя', render: r => `${r.first_name} ${r.last_name}`.trim() },
      { label: 'Роль', render: r => ROLE_LABEL[r.role] ?? r.role },
      { label: 'Магазинов', render: r => r.store_ids.length },
      { label: 'Статус', render: r => badge(r.active ? 'Работает' : 'Заблокирован', r.active ? 'DELIVERED' : 'CANCELLED') },
    ],
    actions: row => [
      {
        label: 'Редактировать',
        onClick: () =>
          renderForm(`Сотрудник: ${row.phone}`, STAFF_UPDATE_FIELDS(), row, async body => {
            await api(`/api/v1/admin/staff/${row.id}`, { method: 'PATCH', body: JSON.stringify(body) });
            message('Сохранено');
            clearForm();
            await load();
          }, clearForm),
      },
    ],
    create: { title: 'Новый сотрудник', fields: STAFF_CREATE_FIELDS, path: '/api/v1/admin/staff' },
  },
  promotions: {
    columns: [
      { label: 'Код', render: r => r.code },
      { label: 'Тип', render: r => PROMO_KIND[r.kind] ?? r.kind },
      { label: 'Значение', render: r => (r.kind === 'PERCENT' ? `${r.value}%` : r.kind === 'FIXED' ? money(r.value) : '—') },
      { label: 'Период', render: r => `${dateTime(r.starts_at)} — ${dateTime(r.ends_at)}` },
      { label: 'Использовано', render: r => `${r.used} / ${r.usage_limit}` },
      { label: 'Активна', render: r => badge(yesNo(r.active), r.active ? 'DELIVERED' : 'CANCELLED') },
    ],
    actions: row => [
      {
        label: row.active ? 'Отключить' : 'Включить',
        onClick: () => action(`/api/v1/admin/promotions/${row.code}`, { active: !row.active }),
      },
    ],
    create: { title: 'Новая акция', fields: PROMOTION_FIELDS, path: '/api/v1/admin/promotions' },
  },
  content: {
    columns: [
      { label: 'Тип', render: r => CONTENT_KIND[r.kind] ?? r.kind },
      { label: 'Заголовок', render: r => localizedText(r.title) },
      { label: 'Показывается', render: r => badge(yesNo(r.active), r.active ? 'DELIVERED' : 'CANCELLED') },
      { label: 'Порядок', render: r => r.sort },
    ],
    actions: row => [{ label: 'Редактировать', onClick: () => editResource('content', row.id, CONTENT_FIELDS, row, 'Материал') }],
    create: { title: 'Новый материал', fields: CONTENT_FIELDS, path: '/api/v1/admin/content' },
  },
  payments: {
    columns: [
      { label: 'Заказ', render: r => short(r.order_id) },
      { label: 'Сумма', render: r => money(r.amount) },
      { label: 'Статус', render: r => badge(PAYMENT_ROW_STATUS[r.status] ?? r.status, r.status) },
      { label: 'Создан', render: r => dateTime(r.created_at) },
    ],
    actions: row =>
      row.status === 'PENDING'
        ? [{ label: 'Тест: оплачено', onClick: () => action(`/api/v1/payments/${row.id}/mock-confirm`, {}, 'Подтвердить тестовую оплату?') }]
        : [],
  },
  refunds: {
    columns: [
      { label: 'Заказ', render: r => short(r.order_id) },
      { label: 'Сумма', render: r => money(r.amount) },
      { label: 'Статус', render: r => badge(REFUND_STATUS[r.status] ?? r.status, r.status) },
      { label: 'Создан', render: r => dateTime(r.created_at) },
    ],
    actions: () => [],
  },
  jobs: {
    columns: [
      { label: 'Тип', render: r => r.kind },
      { label: 'Запуск', render: r => dateTime(r.run_at) },
      { label: 'Попыток', render: r => r.attempts },
      { label: 'Завершена', render: r => (r.completed_at ? dateTime(r.completed_at) : '—') },
      { label: 'Ошибка', render: r => r.last_error ?? '—' },
    ],
    actions: row => (!row.completed_at ? [{ label: 'Повторить', onClick: () => action(`/api/v1/admin/jobs/${row.id}/retry`, {}, 'Повторить выполнение задачи?') }] : []),
  },
  audit: {
    columns: [
      { label: 'Действие', render: r => r.action },
      { label: 'Объект', render: r => short(r.entity_id) },
      { label: 'Когда', render: r => dateTime(r.created_at) },
    ],
    actions: () => [],
  },
  support: {
    columns: [
      { label: 'Статус', render: r => badge(SUPPORT_STATUS[r.status] ?? r.status, r.status) },
      { label: 'Заказ', render: r => (r.order_id ? short(r.order_id) : '—') },
      { label: 'Создано', render: r => dateTime(r.created_at) },
    ],
    actions: row => [{ label: 'Открыть обращение', onClick: () => showSupportThread(row) }],
  },
};

function editResource(resourceName, id, fieldsFn, row, label) {
  renderForm(`${label}: ${localizedText(row.name ?? row.title) ?? ''}`, fieldsFn(), row, async body => {
    await api(`/api/v1/admin/${resourceName}/${id}`, { method: 'PUT', body: JSON.stringify(body) });
    message('Сохранено');
    clearForm();
    await load();
  }, clearForm);
}

function renderCreateForm() {
  const def = RESOURCES[resource];
  if (!def?.create) {
    $('form-area').replaceChildren();
    return;
  }
  renderForm(def.create.title, def.create.fields(), null, async body => {
    await api(def.create.path, { method: def.create.method ?? 'POST', body: JSON.stringify(body) });
    message('Создано');
    clearForm();
    await load();
  });
}

async function showOrderDetail(id) {
  try {
    const order = await api(`/api/v1/admin/orders/${id}`);
    const area = $('detail-area');
    area.replaceChildren();
    const section = document.createElement('section');
    section.className = 'editor';
    const h2 = document.createElement('h2');
    h2.textContent = `Заказ № ${order.number}`;
    const info = document.createElement('p');
    info.textContent = `${ORDER_STATUS[order.status] ?? order.status} · ${PAYMENT_METHOD[order.payment_method]} · ${PAYMENT_STATUS[order.payment_status]} · ${money(order.total)}`;
    const items = document.createElement('ul');
    for (const i of order.items) {
      const li = document.createElement('li');
      const activePrice = i.replacement_status === 'ACCEPTED' ? i.replacement_price : i.unit_price;
      li.textContent = `${localizedText(i.name_snapshot)} × ${i.quantity} — ${money(activePrice)} (${i.picking_status})`;
      items.append(li);
    }
    const close = document.createElement('button');
    close.className = 'secondary';
    close.textContent = 'Закрыть';
    close.onclick = () => area.replaceChildren();
    section.append(h2, info, items, close);
    area.replaceChildren(section);
  } catch (e) {
    message(e.message);
  }
}

async function showSupportThread(thread) {
  try {
    const messages = await api(`/api/v1/support/threads/${thread.id}/messages`);
    const area = $('detail-area');
    area.replaceChildren();
    const section = document.createElement('section');
    section.className = 'editor';
    const h2 = document.createElement('h2');
    h2.textContent = `Обращение: ${SUPPORT_STATUS[thread.status] ?? thread.status}`;
    const list = document.createElement('ul');
    list.className = 'messages';
    for (const m of messages) {
      const li = document.createElement('li');
      li.innerHTML = '';
      const meta = document.createElement('small');
      meta.textContent = dateTime(m.created_at);
      const body = document.createElement('p');
      body.textContent = m.body;
      li.append(meta, body);
      list.append(li);
    }
    const form = document.createElement('form');
    const textarea = document.createElement('textarea');
    textarea.name = 'message';
    textarea.rows = 3;
    textarea.placeholder = 'Ответ клиенту';
    textarea.required = true;
    const send = document.createElement('button');
    send.textContent = 'Отправить';
    form.append(textarea, send);
    form.onsubmit = async e => {
      e.preventDefault();
      try {
        await api(`/api/v1/support/threads/${thread.id}/messages`, { method: 'POST', body: JSON.stringify({ message: textarea.value }) });
        await load();
        await showSupportThread(thread);
      } catch (e) {
        message(e.message);
      }
    };
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'secondary';
    toggle.textContent = thread.status === 'OPEN' ? 'Закрыть обращение' : 'Открыть обращение';
    toggle.onclick = async () => {
      try {
        await api(`/api/v1/support/threads/${thread.id}`, { method: 'PATCH', body: JSON.stringify({ status: thread.status === 'OPEN' ? 'CLOSED' : 'OPEN' }) });
        await load();
        area.replaceChildren();
      } catch (e) {
        message(e.message);
      }
    };
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'secondary';
    close.textContent = 'Закрыть окно';
    close.onclick = () => area.replaceChildren();
    section.append(h2, list, form, toggle, close);
    area.replaceChildren(section);
  } catch (e) {
    message(e.message);
  }
}

function renderSummary(data) {
  const area = $('result');
  area.replaceChildren();
  const counts = document.createElement('div');
  counts.className = 'stats';
  for (const row of data.orders) {
    const stat = document.createElement('div');
    stat.className = 'stat';
    stat.innerHTML = `<strong>${row.count}</strong><span>${ORDER_STATUS[row.status] ?? row.status}</span>`;
    counts.append(stat);
  }
  area.append(counts);
  const lowStockHeading = document.createElement('h2');
  lowStockHeading.textContent = 'Товары на исходе (меньше 5 шт.)';
  area.append(
    lowStockHeading,
    table(
      data.lowStock,
      [
        { label: 'Товар', render: r => localizedText(r.name) },
        { label: 'Остаток', render: r => r.stock },
        { label: 'Зарезервировано', render: r => r.reserved },
        { label: 'Доступно', render: r => r.stock - r.reserved },
      ],
      () => [],
    ),
  );
  const jobsHeading = document.createElement('h2');
  jobsHeading.textContent = 'Задачи, требующие внимания (10+ неудачных попыток)';
  area.append(
    jobsHeading,
    table(
      data.failedJobs,
      [
        { label: 'Тип', render: r => r.kind },
        { label: 'Попыток', render: r => r.attempts },
        { label: 'Ошибка', render: r => r.last_error ?? '—' },
      ],
      row => [{ label: 'Повторить', onClick: () => action(`/api/v1/admin/jobs/${row.id}/retry`, {}, 'Повторить выполнение задачи?') }],
    ),
  );
}

async function load() {
  try {
    $('detail-area').replaceChildren();
    const def = RESOURCES[resource];
    if (resource === 'summary') {
      renderSummary(await api('/api/v1/admin/summary'));
    } else {
      const path = resource === 'support' ? '/api/v1/support/threads' : `/api/v1/admin/${resource}`;
      const rows = await api(path);
      $('result').replaceChildren(table(rows, def.columns, def.actions));
    }
    renderCreateForm();
    document.querySelectorAll('[data-resource]').forEach(b => b.classList.toggle('active', b.dataset.resource === resource));
  } catch (e) {
    message(e.message);
  }
}

$('login-form').onsubmit = async e => {
  e.preventDefault();
  try {
    const data = new FormData(e.target);
    const result = await api('/api/v1/auth/staff/login', {
      method: 'POST',
      body: JSON.stringify({ phone: data.get('phone'), password: data.get('password') }),
    });
    if (result.user.role !== 'ADMIN') {
      await fetch('/api/v1/auth/logout', { method: 'POST', headers: { Authorization: `Bearer ${result.accessToken}` } });
      throw new Error('Панель доступна только администратору');
    }
    accessToken = result.accessToken;
    refreshToken = result.refreshToken;
    e.target.reset();
    $('login').hidden = true;
    $('shell').hidden = false;
    $('logout').hidden = false;
    await loadLookups();
    await load();
  } catch (e) {
    message(e.message);
  }
};
$('logout').onclick = async () => {
  try {
    await api('/api/v1/auth/logout', { method: 'POST' });
  } finally {
    logout();
  }
};
$('refresh').onclick = async () => {
  message('');
  await loadLookups();
  await load();
};
$('tabs').onclick = e => {
  if (e.target.dataset.resource) {
    resource = e.target.dataset.resource;
    message('');
    clearForm();
    $('detail-area').replaceChildren();
    void load();
  }
};
