import { writeFileSync } from 'node:fs';
const string = { type: 'string' },
  boolean = { type: 'boolean' },
  uuid = { type: 'string', format: 'uuid' },
  amount = { type: 'integer', minimum: 0, description: 'Тыйын: 13000 = 130 сом' },
  localized = {
    type: 'object',
    required: ['ru'],
    properties: { ru: string, ky: string, en: string },
    additionalProperties: false,
  };
const object = (properties, required = []) => ({
  type: 'object',
  properties,
  ...(required.length ? { required } : {}),
  additionalProperties: false,
});
const arr = schema => ({ type: 'array', items: schema });
const ref = name => ({ $ref: `#/components/schemas/${name}` });
const nullable = schema => (schema.$ref ? { allOf: [schema], nullable: true } : { ...schema, nullable: true });
const wrap = schema => ({ type: 'object', required: ['data'], properties: { data: schema } });
const dateTime = { type: 'string', format: 'date-time' };
const orderStatus = {
  type: 'string',
  enum: [
    'AWAITING_PAYMENT',
    'CONFIRMED',
    'PICKING',
    'READY',
    'DELIVERING',
    'DELIVERED',
    'CANCELLED',
    'RETURNING',
    'RETURNED',
  ],
};
const paymentMethod = { type: 'string', enum: ['CASH', 'QR'] },
  paymentStatus = { type: 'string', enum: ['UNPAID', 'PAID', 'REFUND_PENDING', 'REFUNDED'] };
const localizedPartial = { type: 'object', properties: { ru: string, ky: string, en: string } };
const nutrition = object({
  calories: { type: 'number' },
  protein: { type: 'number' },
  fat: { type: 'number' },
  carbohydrates: { type: 'number' },
});
// Shared fields reused across request/response schema pairs so the two don't drift out of sync.
const productFields = {
  category_id: uuid,
  name: localized,
  description: localizedPartial,
  composition: localizedPartial,
  nutrition,
  unit: string,
  image_url: nullable(string),
  is_new: boolean,
  age_restricted: boolean,
  active: boolean,
  created_at: dateTime,
};
const orderFields = {
  number: { type: 'integer' },
  user_id: uuid,
  store_id: uuid,
  status: orderStatus,
  payment_method: paymentMethod,
  payment_status: paymentStatus,
  subtotal: amount,
  discount: amount,
  delivery_fee: amount,
  total: amount,
  address_snapshot: { type: 'object' },
  pricing_snapshot: { type: 'object' },
  email: nullable(string),
  courier_comment: string,
  cash_change_from: nullable(amount),
  promo_code: nullable(string),
  idempotency_key: string,
  request_hash: string,
  expires_at: nullable(dateTime),
  waiting_until: nullable(dateTime),
  created_at: dateTime,
  updated_at: dateTime,
};
const schemas = {
  // ---- request bodies ----
  OtpRequest: object(
    { phone: { type: 'string', pattern: '^\\+996\\d{9}$' }, consent: { type: 'boolean', enum: [true] } },
    ['phone', 'consent'],
  ),
  OtpVerify: object({ phone: string, code: { type: 'string', pattern: '^\\d{4}$' } }, ['phone', 'code']),
  StaffLogin: object({ phone: string, password: { type: 'string', format: 'password' } }, ['phone', 'password']),
  Refresh: object({ refreshToken: string }, ['refreshToken']),
  Profile: object({
    firstName: string,
    lastName: string,
    language: { type: 'string', enum: ['ru', 'ky', 'en'] },
    email: { type: 'string', format: 'email', nullable: true },
  }),
  Address: object(
    {
      label: string,
      street: string,
      latitude: { type: 'number', minimum: -90, maximum: 90 },
      longitude: { type: 'number', minimum: -180, maximum: 180 },
      entrance: string,
      intercom: string,
      floor: string,
      apartment: string,
      comment: string,
    },
    ['street', 'latitude', 'longitude'],
  ),
  CartItem: object({ storeId: uuid, quantity: { type: 'integer', minimum: 1, maximum: 100 } }, ['storeId', 'quantity']),
  Checkout: object(
    {
      addressId: uuid,
      paymentMethod: { type: 'string', enum: ['CASH', 'QR'] },
      email: { type: 'string', format: 'email' },
      courierComment: string,
      cashChangeFrom: amount,
      promoCode: string,
      ageConfirmed: boolean,
    },
    ['addressId', 'paymentMethod'],
  ),
  Rating: object({ score: { type: 'integer', minimum: 1, maximum: 5 }, comment: string }, ['score']),
  PickItem: {
    oneOf: [
      object({ action: { type: 'string', enum: ['PICK'] } }, ['action']),
      object({ action: { type: 'string', enum: ['EXCLUDE'] } }, ['action']),
      object({ action: { type: 'string', enum: ['PROPOSE_REPLACEMENT'] }, productId: uuid }, ['action', 'productId']),
    ],
  },
  Replacement: object({ accept: boolean }, ['accept']),
  PaymentEvent: object(
    { eventId: string, paymentId: uuid, status: { type: 'string', enum: ['PAID', 'FAILED'] }, amount },
    ['eventId', 'paymentId', 'status', 'amount'],
  ),
  MockPayment: object({ status: { type: 'string', enum: ['PAID', 'FAILED'], default: 'PAID' } }),
  Thread: object({ orderId: uuid, message: string }, ['message']),
  Message: object({ message: string }, ['message']),
  ThreadStatus: object({ status: { type: 'string', enum: ['OPEN', 'CLOSED'] } }, ['status']),
  Category: object({ name: localized, sort: { type: 'integer', minimum: 0 } }, ['name']),
  Product: object(
    {
      categoryId: uuid,
      name: localized,
      description: localizedPartial,
      composition: localizedPartial,
      nutrition: object({
        calories: { type: 'number', minimum: 0 },
        protein: { type: 'number', minimum: 0 },
        fat: { type: 'number', minimum: 0 },
        carbohydrates: { type: 'number', minimum: 0 },
      }),
      unit: string,
      imageUrl: { type: 'string', format: 'uri', nullable: true },
      isNew: boolean,
      ageRestricted: boolean,
      active: boolean,
    },
    ['categoryId', 'name', 'unit'],
  ),
  Inventory: object({ storeId: uuid, productId: uuid, price: amount, stock: { type: 'integer', minimum: 0 } }, [
    'storeId',
    'productId',
    'price',
    'stock',
  ]),
  Store: object(
    {
      name: string,
      address: string,
      latitude: { type: 'number' },
      longitude: { type: 'number' },
      radiusKm: { type: 'number', minimum: 0, exclusiveMinimum: true },
      deliveryFee: amount,
      minimumOrder: amount,
      opensAt: { type: 'string', example: '09:00' },
      closesAt: { type: 'string', example: '01:00' },
      active: boolean,
    },
    ['name', 'address', 'latitude', 'longitude', 'radiusKm', 'deliveryFee', 'opensAt', 'closesAt'],
  ),
  Staff: object(
    {
      phone: string,
      password: { type: 'string', minLength: 12, maxLength: 128, format: 'password' },
      role: { type: 'string', enum: ['PICKER', 'COURIER', 'ADMIN'] },
      firstName: string,
      lastName: string,
      storeIds: { type: 'array', items: uuid, minItems: 1 },
    },
    ['phone', 'password', 'role', 'firstName', 'storeIds'],
  ),
  StaffUpdate: object({
    active: boolean,
    password: { type: 'string', minLength: 12, maxLength: 128, format: 'password' },
    storeIds: { type: 'array', items: uuid, minItems: 1 },
  }),
  Promotion: object(
    {
      code: string,
      kind: { type: 'string', enum: ['PERCENT', 'FIXED', 'FREE_DELIVERY', 'GIFT'] },
      value: { type: 'integer', minimum: 0, description: 'Для PERCENT: 0–100. Для FIXED: тыйын.' },
      minimumOrder: amount,
      startsAt: { type: 'string', format: 'date-time' },
      endsAt: { type: 'string', format: 'date-time' },
      usageLimit: { type: 'integer', minimum: 1 },
      giftProductId: uuid,
      triggerProductIds: { type: 'array', items: uuid },
    },
    ['code', 'kind', 'startsAt', 'endsAt', 'usageLimit'],
  ),
  PromotionToggle: object({ active: boolean }, ['active']),
  Content: object(
    {
      kind: { type: 'string', enum: ['BANNER', 'STORY', 'NOTICE', 'DOCUMENT', 'COLLECTION'] },
      title: localized,
      body: localizedPartial,
      imageUrl: { type: 'string', format: 'uri', nullable: true },
      productIds: { type: 'array', items: uuid },
      active: boolean,
      sort: { type: 'integer', minimum: 0 },
    },
    ['kind', 'title'],
  ),
  Error: {
    type: 'object',
    properties: {
      error: { type: 'object', properties: { code: string, message: string, details: {}, requestId: string } },
    },
  },
  // ---- response bodies: field names match the real JSON (snake_case from SQL rows, camelCase only where the handler assembles the object in JS) ----
  AuthTokens: object({ accessToken: string, refreshToken: string, expiresIn: { type: 'integer' }, tokenType: string }),
  AuthResult: object({
    accessToken: string,
    refreshToken: string,
    expiresIn: { type: 'integer' },
    tokenType: string,
    user: object({ id: uuid, role: { type: 'string', enum: ['CUSTOMER', 'PICKER', 'COURIER', 'ADMIN'] } }),
  }),
  OtpRequestResult: object({ expiresIn: { type: 'integer' }, retryAfter: { type: 'integer' } }),
  OtpCodeEntry: object({ phone: string, code: { type: 'string', example: '4821' }, expiresAt: dateTime }),
  UserProfile: object({
    id: uuid,
    phone: string,
    first_name: string,
    last_name: string,
    language: { type: 'string', enum: ['ru', 'ky', 'en'] },
    email: nullable(string),
    role: { type: 'string', enum: ['CUSTOMER', 'PICKER', 'COURIER', 'ADMIN'] },
  }),
  AddressResponse: object({
    id: uuid,
    user_id: uuid,
    label: string,
    street: string,
    latitude: { type: 'number' },
    longitude: { type: 'number' },
    entrance: string,
    intercom: string,
    floor: string,
    apartment: string,
    comment: string,
  }),
  StoreResponse: object({
    id: uuid,
    name: string,
    address: string,
    latitude: { type: 'number' },
    longitude: { type: 'number' },
    radius_km: { type: 'number' },
    delivery_fee: amount,
    minimum_order: amount,
    opens_at: string,
    closes_at: string,
    timezone: string,
    active: boolean,
  }),
  StoreAvailability: object({
    id: uuid,
    name: string,
    address: string,
    latitude: { type: 'number' },
    longitude: { type: 'number' },
    radius_km: { type: 'number' },
    radiusKm: { type: 'number', description: 'То же значение, что radius_km, приведённое к числу' },
    delivery_fee: amount,
    minimum_order: amount,
    opens_at: string,
    closes_at: string,
    timezone: string,
    active: boolean,
    distanceKm: { type: 'number' },
    open: boolean,
  }),
  CategoryResponse: object({ id: uuid, name: localized, sort: { type: 'integer' } }),
  ProductResponse: object({ id: uuid, ...productFields }),
  ProductListItem: object({
    id: uuid,
    ...productFields,
    title: string,
    price: amount,
    available: { type: 'integer' },
    availability: { type: 'string', enum: ['AVAILABLE', 'LOW_STOCK', 'OUT_OF_STOCK'] },
  }),
  ProductDetail: object({
    id: uuid,
    ...productFields,
    price: amount,
    available: { type: 'integer' },
    recommendations: arr(ref('ProductListItem')),
  }),
  ContentResponse: object({
    id: uuid,
    kind: { type: 'string', enum: ['BANNER', 'STORY', 'NOTICE', 'DOCUMENT', 'COLLECTION'] },
    title: localized,
    body: localizedPartial,
    image_url: nullable(string),
    product_ids: { type: 'array', items: uuid },
    active: boolean,
    sort: { type: 'integer' },
  }),
  DeliveryAvailability: object({ available: boolean, stores: arr(ref('StoreAvailability')) }),
  Home: object({
    store: ref('StoreResponse'),
    open: boolean,
    content: arr(ref('ContentResponse')),
    products: arr(ref('ProductListItem')),
    delivery: object({
      fee: amount,
      etaMinutes: object({ min: { type: 'integer' }, max: { type: 'integer' } }),
      estimate: boolean,
    }),
  }),
  CartItemResponse: object({
    user_id: uuid,
    product_id: uuid,
    quantity: { type: 'integer' },
    name: localized,
    unit: string,
    price: amount,
    available: { type: 'integer' },
  }),
  Cart: object({ storeId: nullable(uuid), items: arr(ref('CartItemResponse')), subtotal: amount, currency: string }),
  QuoteItem: object({
    product_id: uuid,
    quantity: { type: 'integer' },
    name: localized,
    unit: string,
    active: boolean,
    age_restricted: boolean,
    price: amount,
    available: { type: 'integer' },
    gift: { type: 'boolean', description: 'Присутствует только для подарочной позиции' },
  }),
  CheckoutQuote: object({
    store: ref('StoreResponse'),
    address: ref('AddressResponse'),
    items: arr(ref('QuoteItem')),
    subtotal: amount,
    discount: amount,
    deliveryFee: amount,
    total: amount,
    currency: string,
    etaMinutes: object({ min: { type: 'integer' }, max: { type: 'integer' } }),
    estimate: boolean,
  }),
  OrderItemResponse: object({
    id: uuid,
    order_id: uuid,
    product_id: uuid,
    name_snapshot: localized,
    unit_snapshot: string,
    unit_price: amount,
    quantity: { type: 'integer' },
    picking_status: { type: 'string', enum: ['PENDING', 'PICKED', 'EXCLUDED', 'REPLACED'] },
    replacement_product_id: nullable(uuid),
    replacement_price: nullable(amount),
    replacement_name: nullable(localized),
    replacement_status: nullable({ type: 'string', enum: ['PROPOSED', 'ACCEPTED', 'REJECTED'] }),
    reserved_quantity: { type: 'integer' },
  }),
  OrderResponse: object({ id: uuid, ...orderFields }),
  PickingTaskResponse: object({
    order_id: uuid,
    picker_id: nullable(uuid),
    claimed_at: nullable(dateTime),
    completed_at: nullable(dateTime),
  }),
  DeliveryTaskResponse: object({
    order_id: uuid,
    courier_id: nullable(uuid),
    claimed_at: nullable(dateTime),
    picked_up_at: nullable(dateTime),
    arrived_at: nullable(dateTime),
    completed_at: nullable(dateTime),
    shift_id: nullable(uuid),
  }),
  OrderDetail: object({
    id: uuid,
    ...orderFields,
    items: arr(ref('OrderItemResponse')),
    history: arr(object({ status: string, created_at: dateTime })),
    picking: nullable(ref('PickingTaskResponse')),
    delivery: nullable(ref('DeliveryTaskResponse')),
  }),
  RepeatOrderResult: object({
    unavailable: {
      type: 'array',
      items: uuid,
      description: 'Товары из заказа, которые сейчас недоступны в нужном количестве',
    },
    requiresCheckout: boolean,
  }),
  PickingTaskListItem: object({
    id: uuid,
    number: { type: 'integer' },
    status: { type: 'string', enum: ['CONFIRMED', 'PICKING', 'READY'] },
    store_id: uuid,
    created_at: dateTime,
    picker_id: nullable(uuid),
    claimed_at: nullable(dateTime),
    item_count: { type: 'integer' },
  }),
  DeliveryTaskListItem: object({
    id: uuid,
    number: { type: 'integer' },
    status: { type: 'string', enum: ['CONFIRMED', 'PICKING', 'READY', 'DELIVERING', 'RETURNING'] },
    store_id: uuid,
    pickup_address: string,
    total: amount,
    payment_status: paymentStatus,
    payment_method: paymentMethod,
    courier_id: nullable(uuid),
    address: {
      type: 'object',
      description: 'Полный address_snapshot, если заказ назначен вам, иначе только поле street',
    },
  }),
  PaymentResponse: object({
    id: uuid,
    order_id: uuid,
    amount: amount,
    status: { type: 'string', enum: ['PENDING', 'PAID', 'FAILED', 'EXPIRED'] },
    provider: string,
    idempotency_key: string,
    created_at: dateTime,
  }),
  PaymentCreated: object({
    id: uuid,
    order_id: uuid,
    amount: amount,
    status: { type: 'string', enum: ['PENDING', 'PAID', 'FAILED', 'EXPIRED'] },
    provider: string,
    idempotency_key: string,
    created_at: dateTime,
    testMode: { type: 'boolean', enum: [true] },
    qrPayload: {
      type: 'string',
      example: 'bekbekei-test://payment/...',
      description: 'Тестовый payload, не банковский QR',
    },
    message: string,
  }),
  PaymentEventResult: object({ duplicate: boolean, refundPending: boolean }),
  CourierShiftResponse: object({ id: uuid, courier_id: uuid, started_at: dateTime, ended_at: nullable(dateTime) }),
  CourierStatistics: object({
    orders: { type: 'integer' },
    earnings: amount,
    average_earning: amount,
    rating: nullable({ type: 'number' }),
    ratings: { type: 'integer' },
    currency: string,
    shift: nullable(ref('CourierShiftResponse')),
  }),
  CourierHistoryItem: object({
    id: uuid,
    number: { type: 'integer' },
    status: { type: 'string', enum: ['DELIVERED', 'RETURNED', 'CANCELLED'] },
    address_snapshot: { type: 'object' },
    completed_at: nullable(dateTime),
    earning: nullable(amount),
    score: nullable({ type: 'integer' }),
  }),
  SupportThreadResponse: object({
    id: uuid,
    user_id: uuid,
    order_id: nullable(uuid),
    status: { type: 'string', enum: ['OPEN', 'CLOSED'] },
    created_at: dateTime,
  }),
  SupportThreadCreated: object({ id: uuid }),
  SupportMessageListItem: object({ id: uuid, author_id: uuid, body: string, created_at: dateTime }),
  SupportMessageResponse: object({ id: uuid, thread_id: uuid, author_id: uuid, body: string, created_at: dateTime }),
  StaffSummary: object({
    id: uuid,
    phone: string,
    role: { type: 'string', enum: ['PICKER', 'COURIER', 'ADMIN'] },
    first_name: string,
    last_name: string,
    active: boolean,
    store_ids: { type: 'array', items: uuid },
  }),
  StaffCreated: object({ id: uuid, phone: string, role: { type: 'string', enum: ['PICKER', 'COURIER', 'ADMIN'] } }),
  PromotionResponse: object({
    code: string,
    kind: { type: 'string', enum: ['PERCENT', 'FIXED', 'FREE_DELIVERY', 'GIFT'] },
    value: { type: 'integer' },
    gift_product_id: nullable(uuid),
    trigger_product_ids: { type: 'array', items: uuid },
    minimum_order: amount,
    starts_at: dateTime,
    ends_at: dateTime,
    usage_limit: { type: 'integer' },
    used: { type: 'integer' },
    active: boolean,
  }),
  PromotionCreated: object({ code: string }),
  StoreProductResponse: object({
    store_id: uuid,
    product_id: uuid,
    price: amount,
    stock: { type: 'integer' },
    reserved: { type: 'integer' },
    name: localized,
  }),
  AdminSummary: object({
    orders: arr(object({ status: string, count: { type: 'integer' } })),
    lowStock: arr(ref('StoreProductResponse')),
    failedJobs: arr(object({ id: uuid, kind: string, attempts: { type: 'integer' }, last_error: nullable(string) })),
  }),
  AuditLogResponse: object({
    id: { type: 'integer' },
    actor_id: nullable(uuid),
    action: string,
    entity_id: nullable(string),
    payload: { type: 'object' },
    created_at: dateTime,
  }),
  JobResponse: object({
    id: uuid,
    kind: string,
    payload: { type: 'object' },
    run_at: dateTime,
    attempts: { type: 'integer' },
    completed_at: nullable(dateTime),
    last_error: nullable(string),
  }),
  RefundResponse: object({
    id: uuid,
    order_id: uuid,
    amount: amount,
    status: { type: 'string', enum: ['PENDING', 'COMPLETED', 'FAILED'] },
    created_at: dateTime,
  }),
  HealthStatus: object({ status: string, service: string }),
  ReadyStatus: object({ status: string }),
};
schemas.CreateOrder = object({ ...schemas.Checkout.properties, expectedTotal: amount }, [
  ...schemas.Checkout.required,
  'expectedTotal',
]);
const spec = {
  openapi: '3.0.3',
  info: {
    title: 'Бекбекей · API доставки продуктов',
    version: '0.1.0',
    description:
      'Рабочий MVP по PDF-макету. SMS выводятся только в серверный лог. QR-платежи и возвраты — тестовая имитация. Цены передаются в тыйынах (KGS × 100). Вход: opaque Bearer access token на 15 минут, refresh token на 30 дней. Поля запросов — camelCase; SQL-ответы — snake_case. Списки: limit/offset. Перед оформлением запросите checkout/quote.',
  },
  servers: [{ url: 'http://localhost:3000' }],
  tags: [
    'Auth',
    'Catalog',
    'Customer',
    'Orders',
    'Payments',
    'Picking',
    'Delivery',
    'Courier',
    'Support',
    'Admin',
    'Events',
    'System',
  ].map(name => ({ name })),
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', description: 'accessToken из ответа авторизации' },
    },
    schemas,
  },
  paths: {},
};
function route(
  method,
  path,
  tag,
  summary,
  {
    body,
    role = 'PUBLIC',
    status = 200,
    query = [],
    key = false,
    description = '',
    raw = false,
    response = { description: 'Результат операции' },
  } = {},
) {
  const parameters = [];
  for (const m of path.matchAll(/\{([^}]+)\}/g))
    parameters.push({ in: 'path', name: m[1], required: true, schema: m[1] === 'code' ? string : uuid });
  for (const [name, schema, required = false] of query) parameters.push({ in: 'query', name, required, schema });
  if (key)
    parameters.push({
      in: 'header',
      name: 'Idempotency-Key',
      required: true,
      schema: { type: 'string', minLength: 8, maxLength: 128 },
      description: 'Уникальный ключ логической операции. При повторе используйте тот же ключ.',
    });
  if (raw)
    parameters.push({
      in: 'header',
      name: 'X-Payment-Signature',
      required: true,
      schema: string,
      description: 'Hex HMAC-SHA256 от точных байтов JSON, секрет PAYMENT_WEBHOOK_SECRET',
    });
  const responses = {
    [status]: {
      description: status === 204 ? 'Операция выполнена' : 'Успешный ответ',
      ...(status !== 204 ? { content: { 'application/json': { schema: wrap(response) } } } : {}),
    },
  };
  for (const code of [400, 401, 403, 404, 409, 422, 429, 500, 503])
    responses[code] = {
      description: {
        400: 'Неверный код или JSON',
        401: 'Требуется вход',
        403: 'Недостаточно прав',
        404: 'Запись не найдена',
        409: 'Конфликт состояния, цены или остатков',
        422: 'Ошибка проверки данных',
        429: 'Ограничение частоты',
        500: 'Ошибка сервера',
        503: 'Интеграция отключена',
      }[code],
      content: { 'application/json': { schema: ref('Error') } },
    };
  const op = {
    tags: [tag],
    summary,
    description: `Роль: ${role}. ${description}`,
    operationId: `${method}_${path.replace(/[^a-zA-Z0-9]/g, '_')}`,
    security: role === 'PUBLIC' ? [] : [{ bearerAuth: [] }],
    parameters,
    responses,
  };
  if (body) op.requestBody = { required: true, content: { 'application/json': { schema: ref(body) } } };
  (spec.paths[path] ??= {})[method] = op;
}
const pag = [
  ['limit', { type: 'integer', minimum: 1, maximum: 100, default: 30 }],
  ['offset', { type: 'integer', minimum: 0, default: 0 }],
];
const store = [['storeId', uuid, true]],
  products = [
    ...store,
    ['categoryId', uuid],
    ['search', string],
    ['language', { type: 'string', enum: ['ru', 'ky', 'en'] }],
    ['filter', { type: 'string', enum: ['all', 'new'] }],
    ...pag,
  ];
const base = '/api/v1';
const add = (method, path, tag, title, options) => route(method, base + path, tag, title, options);
route('get', '/health', 'System', 'Жив ли процесс', { response: ref('HealthStatus') });
route('get', '/ready', 'System', 'Доступна ли база данных', { response: ref('ReadyStatus') });
add('post', '/auth/otp/request', 'Auth', 'Запросить SMS-код', {
  body: 'OtpRequest',
  status: 202,
  description:
    'Код не возвращается в API. В режиме разработки смотрите серверный лог. Повтор через 60 секунд, TTL 5 минут.',
  response: ref('OtpRequestResult'),
});
add('post', '/auth/otp/verify', 'Auth', 'Проверить код и войти', {
  body: 'OtpVerify',
  description: 'Не более 5 попыток. Возвращает accessToken, refreshToken, expiresIn и user.',
  response: ref('AuthResult'),
});
add('post', '/auth/staff/login', 'Auth', 'Вход сотрудника', { body: 'StaffLogin', response: ref('AuthResult') });
add('post', '/auth/refresh', 'Auth', 'Обновить и ротировать сеанс', { body: 'Refresh', response: ref('AuthTokens') });
add('post', '/auth/logout', 'Auth', 'Отозвать сеанс', { role: 'ANY', status: 204 });
add('get', '/stores', 'Catalog', 'Открытые для обслуживания магазины', { response: arr(ref('StoreResponse')) });
add('get', '/delivery/availability', 'Catalog', 'Проверить зону доставки', {
  query: [
    ['latitude', { type: 'number' }, true],
    ['longitude', { type: 'number' }, true],
  ],
  response: ref('DeliveryAvailability'),
});
add('get', '/categories', 'Catalog', 'Категории', { response: arr(ref('CategoryResponse')) });
add('get', '/products', 'Catalog', 'Каталог и поиск', { query: products, response: arr(ref('ProductListItem')) });
add('get', '/products/{id}', 'Catalog', 'Карточка товара и рекомендации', {
  query: store,
  response: ref('ProductDetail'),
});
add('get', '/home', 'Catalog', 'Главная страница', { query: [...store, ['language', string]], response: ref('Home') });
add('get', '/content', 'Catalog', 'Баннеры, истории и документы', {
  query: [['kind', { type: 'string', enum: ['BANNER', 'STORY', 'NOTICE', 'DOCUMENT', 'COLLECTION'] }]],
  response: arr(ref('ContentResponse')),
});
add('get', '/me', 'Customer', 'Мой профиль', { role: 'ANY', response: ref('UserProfile') });
add('patch', '/me', 'Customer', 'Изменить профиль', { role: 'ANY', body: 'Profile', response: ref('UserProfile') });
add('get', '/me/addresses', 'Customer', 'Мои адреса', { role: 'CUSTOMER', response: arr(ref('AddressResponse')) });
add('post', '/me/addresses', 'Customer', 'Сохранить адрес', {
  role: 'CUSTOMER',
  body: 'Address',
  status: 201,
  response: ref('AddressResponse'),
});
add('put', '/me/addresses/{id}', 'Customer', 'Обновить адрес полностью', {
  role: 'CUSTOMER',
  body: 'Address',
  response: ref('AddressResponse'),
});
add('delete', '/me/addresses/{id}', 'Customer', 'Удалить адрес', { role: 'CUSTOMER', status: 204 });
for (const p of ['favorites', 'purchased'])
  add('get', `/me/${p}`, 'Customer', p === 'favorites' ? 'Избранное' : 'Ранее купленные товары', {
    role: 'CUSTOMER',
    query: [...store, ...pag],
    response: arr(ref('ProductListItem')),
  });
add('put', '/me/favorites/{id}', 'Customer', 'Добавить в избранное', { role: 'CUSTOMER', status: 204 });
add('delete', '/me/favorites/{id}', 'Customer', 'Удалить из избранного', { role: 'CUSTOMER', status: 204 });
add('get', '/cart', 'Orders', 'Получить корзину', { role: 'CUSTOMER', response: ref('Cart') });
add('put', '/cart/items/{id}', 'Orders', 'Установить количество товара', {
  role: 'CUSTOMER',
  body: 'CartItem',
  status: 204,
});
add('delete', '/cart/items/{id}', 'Orders', 'Удалить позицию', { role: 'CUSTOMER', status: 204 });
add('delete', '/cart', 'Orders', 'Очистить корзину', { role: 'CUSTOMER', status: 204 });
add('post', '/checkout/quote', 'Orders', 'Рассчитать стоимость заказа', {
  role: 'CUSTOMER',
  body: 'Checkout',
  description: 'Сумма не резервирует товар. Первая активная покупка получает бесплатную доставку.',
  response: ref('CheckoutQuote'),
});
add('post', '/orders', 'Orders', 'Создать заказ и зарезервировать остатки', {
  role: 'CUSTOMER',
  body: 'CreateOrder',
  key: true,
  status: 201,
  description:
    'expectedTotal берётся из quote. При повторе с тем же ключом возвращается существующий заказ с HTTP 200.',
  response: ref('OrderDetail'),
});
add('get', '/orders', 'Orders', 'История заказов', {
  role: 'CUSTOMER',
  query: pag,
  response: arr(ref('OrderResponse')),
});
add('get', '/orders/{id}', 'Orders', 'Заказ, позиции и история статусов', {
  role: 'CUSTOMER',
  response: ref('OrderDetail'),
});
add('post', '/orders/{id}/cancel', 'Orders', 'Отменить заказ', {
  role: 'CUSTOMER',
  description: 'Допустимо до READY. Повторная отмена безопасна.',
  response: ref('OrderDetail'),
});
add('post', '/orders/{id}/repeat', 'Orders', 'Перенести доступные позиции в пустую корзину', {
  role: 'CUSTOMER',
  description: 'Не создаёт заказ автоматически. Цены проверяются заново.',
  response: ref('RepeatOrderResult'),
});
add('put', '/orders/{id}/rating', 'Orders', 'Оценить доставку', { role: 'CUSTOMER', body: 'Rating', status: 204 });
add('post', '/orders/{id}/items/{itemId}/replacement', 'Orders', 'Согласовать или отклонить замену', {
  role: 'CUSTOMER',
  body: 'Replacement',
  response: ref('OrderDetail'),
});
add('post', '/orders/{id}/payments', 'Payments', 'Создать тестовый QR-платёж', {
  role: 'CUSTOMER',
  key: true,
  status: 201,
  description: 'Тестовый QR payload не является банковским QR. Один незавершённый платёж на заказ.',
  response: ref('PaymentCreated'),
});
add('get', '/payments/{id}', 'Payments', 'Статус платежа', {
  role: 'Владелец заказа или ADMIN',
  response: ref('PaymentResponse'),
});
add('post', '/payments/{id}/mock-confirm', 'Payments', 'Подтвердить тестовый платёж', {
  role: 'ADMIN',
  body: 'MockPayment',
  response: ref('PaymentEventResult'),
});
add('post', '/webhooks/payments/mock', 'Payments', 'Подписанное событие тестового платежа', {
  body: 'PaymentEvent',
  raw: true,
  description: 'Подпись проверяется до чтения JSON. eventId уникален. Повтор с другим содержимым — конфликт.',
  response: ref('PaymentEventResult'),
});
for (const group of ['picking', 'delivery']) {
  const tag = group === 'picking' ? 'Picking' : 'Delivery',
    role = group === 'picking' ? 'PICKER' : 'COURIER',
    listItem = group === 'picking' ? 'PickingTaskListItem' : 'DeliveryTaskListItem';
  add('get', `/${group}/tasks`, tag, 'Доступные и назначенные задания', {
    role,
    query: pag,
    response: arr(ref(listItem)),
  });
  add('get', `/${group}/tasks/{id}`, tag, 'Моё назначенное задание', { role, response: ref('OrderDetail') });
  add('post', `/${group}/tasks/{id}/claim`, tag, 'Атомарно взять задание', { role, response: ref('OrderDetail') });
}
add('patch', '/picking/tasks/{id}/items/{itemId}', 'Picking', 'Собрать, исключить или предложить замену', {
  role: 'PICKER',
  body: 'PickItem',
  description: 'QR-заказ допускает замену только на товар не дороже. Принятая замена считается обработанной позицией.',
  response: ref('OrderDetail'),
});
add('post', '/picking/tasks/{id}/complete', 'Picking', 'Завершить сборку', {
  role: 'PICKER',
  response: ref('OrderDetail'),
});
for (const [action, summary, status, response] of [
  ['pickup', 'Забрать собранный заказ', 200, ref('OrderDetail')],
  ['arrive', 'Отметить прибытие', 204],
  ['confirm-cash', 'Подтвердить получение наличных', 204],
  ['complete', 'Подтвердить вручение', 200, ref('OrderDetail')],
  ['report-unreachable', 'Клиент не отвечает: начать ожидание', 200, ref('OrderDetail')],
  ['return', 'Подтвердить возврат в магазин', 200, ref('OrderDetail')],
])
  add('post', `/delivery/tasks/{id}/${action}`, 'Delivery', summary, { role: 'COURIER', status, response });
add('post', '/courier/shifts/start', 'Courier', 'Начать смену', {
  role: 'COURIER',
  response: ref('CourierShiftResponse'),
});
add('post', '/courier/shifts/end', 'Courier', 'Закончить смену', { role: 'COURIER', status: 204 });
add('get', '/courier/statistics', 'Courier', 'Заработок и рейтинг', {
  role: 'COURIER',
  query: [['period', { type: 'string', enum: ['today', 'week', 'month'] }]],
  response: ref('CourierStatistics'),
});
add('get', '/courier/history', 'Courier', 'История доставки', {
  role: 'COURIER',
  query: pag,
  response: arr(ref('CourierHistoryItem')),
});
add('get', '/support/threads', 'Support', 'Мои обращения, для админа — все', {
  role: 'ANY',
  query: pag,
  response: arr(ref('SupportThreadResponse')),
});
add('post', '/support/threads', 'Support', 'Создать обращение', {
  role: 'ANY',
  body: 'Thread',
  status: 201,
  response: ref('SupportThreadCreated'),
});
add('get', '/support/threads/{id}/messages', 'Support', 'Сообщения обращения', {
  role: 'Владелец или ADMIN',
  query: pag,
  response: arr(ref('SupportMessageListItem')),
});
add('post', '/support/threads/{id}/messages', 'Support', 'Написать сообщение', {
  role: 'Владелец или ADMIN',
  body: 'Message',
  status: 201,
  response: ref('SupportMessageResponse'),
});
add('patch', '/support/threads/{id}', 'Support', 'Закрыть или открыть обращение', {
  role: 'ADMIN',
  body: 'ThreadStatus',
  response: ref('SupportThreadResponse'),
});
add('get', '/admin/otp-codes', 'Admin', 'Текущие коды входа (только вне production)', {
  role: 'ADMIN',
  description:
    'Коды, которые клиент ещё не подтвердил. Замена чтению журнала сервера при разработке; в production эндпоинт отключён.',
  response: arr(ref('OtpCodeEntry')),
});
const adminListResponse = {
  summary: ref('AdminSummary'),
  orders: arr(ref('OrderResponse')),
  stores: arr(ref('StoreResponse')),
  categories: arr(ref('CategoryResponse')),
  products: arr(ref('ProductResponse')),
  inventory: arr(ref('StoreProductResponse')),
  staff: arr(ref('StaffSummary')),
  promotions: arr(ref('PromotionResponse')),
  content: arr(ref('ContentResponse')),
  refunds: arr(ref('RefundResponse')),
  payments: arr(ref('PaymentResponse')),
  jobs: arr(ref('JobResponse')),
  audit: arr(ref('AuditLogResponse')),
};
for (const name of Object.keys(adminListResponse))
  add('get', `/admin/${name}`, 'Admin', `Управление: ${name}`, {
    role: 'ADMIN',
    query: ['orders', 'products', 'inventory', 'refunds', 'payments', 'jobs', 'audit'].includes(name) ? pag : [],
    response: adminListResponse[name],
  });
add('get', '/admin/orders/{id}', 'Admin', 'Детали любого заказа', { role: 'ADMIN', response: ref('OrderDetail') });
add('post', '/admin/orders/{id}/cancel', 'Admin', 'Отменить заказ', { role: 'ADMIN', response: ref('OrderDetail') });
add('post', '/admin/orders/{id}/authorize-return', 'Admin', 'Разрешить возврат в магазин', {
  role: 'ADMIN',
  status: 204,
});
const adminResponseName = {
  stores: 'StoreResponse',
  categories: 'CategoryResponse',
  products: 'ProductResponse',
  content: 'ContentResponse',
};
for (const [path, schema] of [
  ['stores', 'Store'],
  ['categories', 'Category'],
  ['products', 'Product'],
  ['content', 'Content'],
]) {
  add('post', `/admin/${path}`, 'Admin', `Создать: ${path}`, {
    role: 'ADMIN',
    body: schema,
    status: 201,
    response: ref(adminResponseName[path]),
  });
  add('put', `/admin/${path}/{id}`, 'Admin', `Обновить полностью: ${path}`, {
    role: 'ADMIN',
    body: schema,
    response: ref(adminResponseName[path]),
  });
}
add('put', '/admin/inventory', 'Admin', 'Установить цену и физический остаток', {
  role: 'ADMIN',
  body: 'Inventory',
  status: 204,
});
add('post', '/admin/staff', 'Admin', 'Создать сотрудника', {
  role: 'ADMIN',
  body: 'Staff',
  status: 201,
  response: ref('StaffCreated'),
});
add('patch', '/admin/staff/{id}', 'Admin', 'Обновить сотрудника и отозвать его сеансы', {
  role: 'ADMIN',
  body: 'StaffUpdate',
  status: 204,
});
add('post', '/admin/promotions', 'Admin', 'Создать акцию', {
  role: 'ADMIN',
  body: 'Promotion',
  status: 201,
  response: ref('PromotionCreated'),
});
add('patch', '/admin/promotions/{code}', 'Admin', 'Включить или отключить акцию', {
  role: 'ADMIN',
  body: 'PromotionToggle',
  status: 204,
});
add('post', '/admin/jobs/{id}/retry', 'Admin', 'Повторить незавершённую задачу', { role: 'ADMIN', status: 204 });
add('get', '/events', 'Events', 'Поток событий SSE', {
  role: 'ANY',
  query: [['after', { type: 'integer', minimum: 0 }]],
  description:
    'Authorization: Bearer обязателен. Используйте fetch-stream, обычный EventSource не позволяет задать этот заголовок. Переподключение: Last-Event-ID либо after. Поток закрывается при истечении access token.',
});
spec.paths['/api/v1/events'].get.responses[200] = {
  description: 'SSE: id, event, data',
  content: { 'text/event-stream': { schema: { type: 'string' } } },
};
spec.paths['/api/v1/orders'].post.responses[200] = {
  description: 'Заказ уже создан с этим ключом',
  content: { 'application/json': { schema: wrap(ref('OrderDetail')) } },
};
writeFileSync('docs/openapi.json', JSON.stringify(spec, null, 2) + '\n');
console.log(`${Object.keys(spec.paths).length} путей OpenAPI`);
