import type { Column, Layout, Schema, Table, TableType } from '../types/schema'
import type { Lang } from '../i18n'

interface Section {
  tag: string
  title: Record<Lang, string>
  tables: Table[]
  context?: string[]
}

const column = (name: string, type: string, flags?: Pick<Column, 'nullable' | 'unique'>): Column => ({ name, type, ...flags })
const ref = (name: string, table: string, flags?: Pick<Column, 'nullable'>): Column =>
  ({ name, type: 'integer', foreignKey: { table, column: 'id' }, ...flags })

function table(name: string, type: TableType, ...columns: Column[]): Table {
  const primaryKey: Column = { name: 'id', type: 'integer', primaryKey: true }
  return { name, type, columns: [primaryKey, ...columns] }
}

function junction(name: string, first: Column, second: Column, ...columns: Column[]): Table {
  return { name, type: 'link', columns: [{ ...first, primaryKey: true }, { ...second, primaryKey: true }, ...columns] }
}

const library: Section[] = [{
  tag: 'library',
  title: { en: 'Library', ru: 'Библиотека' },
  tables: [
    table('authors', 'master',
      column('full_name', 'varchar(160)'),
      column('birth_year', 'smallint', { nullable: true }),
    ),
    table('books', 'master',
      ref('author_id', 'authors'),
      column('title', 'varchar(200)'),
      column('isbn', 'varchar(13)', { unique: true }),
      column('published_year', 'smallint'),
    ),
    table('book_copies', 'master',
      ref('book_id', 'books'),
      column('barcode', 'varchar(40)', { unique: true }),
      column('shelf_code', 'varchar(20)'),
    ),
    table('members', 'master',
      column('full_name', 'varchar(160)'),
      column('email', 'varchar(254)', { unique: true }),
      column('joined_on', 'date'),
    ),
    table('loans', 'transaction',
      ref('copy_id', 'book_copies'),
      ref('member_id', 'members'),
      column('borrowed_on', 'date'),
      column('due_on', 'date'),
      column('returned_on', 'date', { nullable: true }),
    ),
  ],
}]

const school: Section[] = [
  {
    tag: 'enrollment',
    title: { en: 'Enrollment', ru: 'Зачисление' },
    context: ['school_years', 'class_groups'],
    tables: [
      table('students', 'master',
        column('student_number', 'varchar(24)', { unique: true }),
        column('full_name', 'varchar(160)'),
        column('birth_date', 'date'),
      ),
      table('guardians', 'master',
        column('full_name', 'varchar(160)'),
        column('phone', 'varchar(24)'),
        column('email', 'varchar(254)', { nullable: true }),
      ),
      junction('student_guardians',
        ref('student_id', 'students'),
        ref('guardian_id', 'guardians'),
        column('relationship', 'varchar(30)'),
        column('emergency_contact', 'boolean'),
      ),
      table('enrollments', 'transaction',
        ref('student_id', 'students'),
        ref('class_group_id', 'class_groups'),
        column('enrolled_on', 'date'),
        column('left_on', 'date', { nullable: true }),
      ),
    ],
  },
  {
    tag: 'schedule',
    title: { en: 'Schedule', ru: 'Расписание' },
    tables: [
      table('school_years', 'reference',
        column('label', 'varchar(9)', { unique: true }),
        column('starts_on', 'date'),
        column('ends_on', 'date'),
      ),
      table('class_groups', 'master',
        ref('school_year_id', 'school_years'),
        ref('homeroom_teacher_id', 'teachers'),
        column('label', 'varchar(12)'),
        column('grade_level', 'smallint'),
      ),
      table('teachers', 'master',
        column('full_name', 'varchar(160)'),
        column('work_email', 'varchar(254)', { unique: true }),
      ),
      table('subjects', 'reference',
        column('code', 'varchar(16)', { unique: true }),
        column('name', 'varchar(80)'),
      ),
      table('rooms', 'reference',
        column('room_number', 'varchar(12)', { unique: true }),
        column('capacity', 'smallint'),
      ),
      table('lessons', 'transaction',
        ref('class_group_id', 'class_groups'),
        ref('teacher_id', 'teachers'),
        ref('subject_id', 'subjects'),
        ref('room_id', 'rooms'),
        column('starts_at', 'timestamp'),
        column('ends_at', 'timestamp'),
      ),
    ],
  },
  {
    tag: 'student_records',
    title: { en: 'Student records', ru: 'Учёт учеников' },
    context: ['students', 'enrollments', 'lessons', 'class_groups'],
    tables: [
      junction('attendance',
        ref('lesson_id', 'lessons'),
        ref('student_id', 'students'),
        column('status', 'varchar(16)'),
        column('note', 'text', { nullable: true }),
      ),
      table('student_documents', 'transaction',
        ref('student_id', 'students'),
        column('document_type', 'varchar(32)'),
        column('reference_number', 'varchar(40)'),
        column('issued_on', 'date'),
        column('verified_at', 'timestamp', { nullable: true }),
      ),
    ],
  },
]

const store: Section[] = [
  {
    tag: 'catalog',
    title: { en: 'Catalog', ru: 'Каталог' },
    tables: [
      table('categories', 'reference',
        column('slug', 'varchar(120)', { unique: true }),
        column('name', 'varchar(100)'),
      ),
      table('brands', 'reference',
        column('name', 'varchar(100)', { unique: true }),
      ),
      table('products', 'master',
        ref('brand_id', 'brands'),
        column('title', 'varchar(180)'),
        column('description', 'text', { nullable: true }),
        column('is_active', 'boolean'),
      ),
      junction('product_categories',
        ref('product_id', 'products'),
        ref('category_id', 'categories'),
      ),
      table('product_variants', 'master',
        ref('product_id', 'products'),
        column('sku', 'varchar(40)', { unique: true }),
        column('label', 'varchar(100)'),
        column('list_price', 'numeric(12,2)'),
        column('weight_grams', 'integer'),
      ),
      table('variant_images', 'master',
        ref('variant_id', 'product_variants'),
        column('image_url', 'text'),
        column('display_order', 'smallint'),
      ),
    ],
  },
  {
    tag: 'inventory',
    title: { en: 'Inventory', ru: 'Склады и закупки' },
    context: ['product_variants'],
    tables: [
      table('warehouses', 'master',
        column('code', 'varchar(16)', { unique: true }),
        column('city', 'varchar(100)'),
        column('address', 'text'),
      ),
      table('suppliers', 'master',
        column('company_name', 'varchar(160)'),
        column('contact_email', 'varchar(254)'),
      ),
      junction('supplier_products',
        ref('supplier_id', 'suppliers'),
        ref('variant_id', 'product_variants'),
        column('supplier_sku', 'varchar(50)'),
        column('unit_cost', 'numeric(12,2)'),
      ),
      table('purchase_orders', 'transaction',
        ref('supplier_id', 'suppliers'),
        ref('warehouse_id', 'warehouses'),
        column('status', 'varchar(24)'),
        column('ordered_at', 'timestamptz'),
      ),
      table('purchase_items', 'transaction',
        ref('purchase_order_id', 'purchase_orders'),
        ref('variant_id', 'product_variants'),
        column('quantity', 'integer'),
        column('unit_cost', 'numeric(12,2)'),
      ),
      junction('stock_levels',
        ref('warehouse_id', 'warehouses'),
        ref('variant_id', 'product_variants'),
        column('on_hand', 'integer'),
        column('reserved', 'integer'),
      ),
      table('stock_movements', 'transaction',
        ref('warehouse_id', 'warehouses'),
        ref('variant_id', 'product_variants'),
        ref('purchase_item_id', 'purchase_items', { nullable: true }),
        ref('shipment_item_id', 'shipment_items', { nullable: true }),
        column('quantity_delta', 'integer'),
        column('recorded_at', 'timestamptz'),
      ),
    ],
  },
  {
    tag: 'customers',
    title: { en: 'Customers', ru: 'Покупатели' },
    context: ['product_variants'],
    tables: [
      table('customers', 'master',
        column('email', 'varchar(254)', { unique: true }),
        column('full_name', 'varchar(160)'),
        column('registered_at', 'timestamptz'),
      ),
      table('customer_addresses', 'master',
        ref('customer_id', 'customers'),
        column('recipient', 'varchar(160)'),
        column('country_code', 'char(2)'),
        column('city', 'varchar(100)'),
        column('postal_code', 'varchar(16)'),
        column('address_line', 'text'),
      ),
      table('customer_segments', 'reference',
        column('code', 'varchar(24)', { unique: true }),
        column('label', 'varchar(80)'),
      ),
      junction('segment_memberships',
        ref('customer_id', 'customers'),
        ref('segment_id', 'customer_segments'),
        column('joined_at', 'timestamptz'),
      ),
      table('wishlists', 'master',
        ref('customer_id', 'customers'),
        column('title', 'varchar(80)'),
        column('created_at', 'timestamptz'),
      ),
      junction('wishlist_items',
        ref('wishlist_id', 'wishlists'),
        ref('variant_id', 'product_variants'),
        column('added_at', 'timestamptz'),
      ),
    ],
  },
  {
    tag: 'sales',
    title: { en: 'Sales', ru: 'Корзины и заказы' },
    context: ['customers', 'customer_addresses', 'product_variants', 'customer_segments'],
    tables: [
      table('carts', 'transaction',
        ref('customer_id', 'customers'),
        column('created_at', 'timestamptz'),
        column('checked_out_at', 'timestamptz', { nullable: true }),
      ),
      junction('cart_items',
        ref('cart_id', 'carts'),
        ref('variant_id', 'product_variants'),
        column('quantity', 'integer'),
      ),
      table('orders', 'transaction',
        ref('customer_id', 'customers'),
        ref('cart_id', 'carts', { nullable: true }),
        ref('shipping_address_id', 'customer_addresses'),
        column('order_number', 'varchar(30)', { unique: true }),
        column('status', 'varchar(24)'),
        column('currency_code', 'char(3)'),
        column('placed_at', 'timestamptz'),
      ),
      table('order_items', 'transaction',
        ref('order_id', 'orders'),
        ref('variant_id', 'product_variants'),
        column('quantity', 'integer'),
        column('unit_price', 'numeric(12,2)'),
      ),
      table('promotions', 'master',
        ref('segment_id', 'customer_segments', { nullable: true }),
        column('code', 'varchar(32)', { unique: true }),
        column('percent_off', 'numeric(5,2)'),
        column('starts_at', 'timestamptz'),
        column('ends_at', 'timestamptz'),
      ),
      junction('order_promotions',
        ref('order_id', 'orders'),
        ref('promotion_id', 'promotions'),
        column('discount_amount', 'numeric(12,2)'),
      ),
    ],
  },
  {
    tag: 'fulfillment',
    title: { en: 'Fulfillment', ru: 'Доставка' },
    context: ['orders', 'order_items', 'warehouses'],
    tables: [
      table('carriers', 'reference',
        column('code', 'varchar(20)', { unique: true }),
        column('name', 'varchar(100)'),
      ),
      table('shipping_services', 'reference',
        ref('carrier_id', 'carriers'),
        column('service_code', 'varchar(30)'),
        column('label', 'varchar(80)'),
      ),
      table('shipments', 'transaction',
        ref('order_id', 'orders'),
        ref('warehouse_id', 'warehouses'),
        ref('shipping_service_id', 'shipping_services'),
        column('tracking_number', 'varchar(64)', { nullable: true }),
        column('shipped_at', 'timestamptz', { nullable: true }),
      ),
      table('shipment_items', 'transaction',
        ref('shipment_id', 'shipments'),
        ref('order_item_id', 'order_items'),
        column('quantity', 'integer'),
      ),
      table('tracking_events', 'transaction',
        ref('shipment_id', 'shipments'),
        column('status', 'varchar(24)'),
        column('location', 'varchar(120)', { nullable: true }),
        column('occurred_at', 'timestamptz'),
      ),
    ],
  },
  {
    tag: 'billing',
    title: { en: 'Payments and returns', ru: 'Оплата и возвраты' },
    context: ['orders', 'order_items'],
    tables: [
      table('payment_methods', 'reference',
        column('code', 'varchar(20)', { unique: true }),
        column('label', 'varchar(80)'),
      ),
      table('payments', 'transaction',
        ref('order_id', 'orders'),
        ref('method_id', 'payment_methods'),
        column('provider_reference', 'varchar(80)', { unique: true }),
        column('amount', 'numeric(12,2)'),
        column('status', 'varchar(24)'),
        column('paid_at', 'timestamptz', { nullable: true }),
      ),
      table('return_reasons', 'reference',
        column('code', 'varchar(24)', { unique: true }),
        column('label', 'varchar(100)'),
      ),
      table('return_requests', 'transaction',
        ref('order_id', 'orders'),
        column('status', 'varchar(24)'),
        column('requested_at', 'timestamptz'),
      ),
      junction('return_items',
        ref('return_request_id', 'return_requests'),
        ref('order_item_id', 'order_items'),
        ref('reason_id', 'return_reasons'),
        column('quantity', 'integer'),
      ),
      table('refunds', 'transaction',
        ref('payment_id', 'payments'),
        ref('return_request_id', 'return_requests', { nullable: true }),
        column('amount', 'numeric(12,2)'),
        column('issued_at', 'timestamptz'),
      ),
    ],
  },
]

export const demoSchemas = [
  { id: 'library', sections: library },
  { id: 'school', sections: school },
  { id: 'store', sections: store },
] as const

type Demo = typeof demoSchemas[number]

const COLUMN_SPACING = 430
const ROW_SPACING = 330
const SECTION_GAP = 150

function gridPositions(names: string[], columns: number, x = 0, y = 0): Layout['positions'] {
  return Object.fromEntries(names.map((name, index) => [name, {
    x: x + (index % columns) * COLUMN_SPACING,
    y: y + Math.floor(index / columns) * ROW_SPACING,
  }]))
}

export function openDemoSchema(demo: Demo, lang: Lang): { schema: Schema; positions: Layout['positions'] } {
  const tables = demo.sections.flatMap(section => section.tables.map(source => ({
    ...structuredClone(source),
    tags: [section.tag],
  })))
  const layouts: Layout[] = []
  const positions: Layout['positions'] = {}
  const columns = demo.id === 'library' ? 2 : 3
  let y = 0
  for (let index = 0; index < demo.sections.length; index += 2) {
    const row = demo.sections.slice(index, index + 2)
    row.forEach((section, sectionIndex) => {
      const names = section.tables.map(table => table.name)
      Object.assign(positions, gridPositions(names, columns, sectionIndex * (columns * COLUMN_SPACING + SECTION_GAP), y))
      if (demo.sections.length > 1) {
        const layoutTables = [...names, ...(section.context ?? [])]
        layouts.push({
          id: `${demo.id}-${section.tag}`,
          name: section.title[lang],
          tables: layoutTables,
          positions: gridPositions(layoutTables, columns),
        })
      }
    })
    y += Math.max(...row.map(section => Math.ceil(section.tables.length / columns))) * ROW_SPACING + SECTION_GAP
  }
  return { schema: { tables, layouts }, positions }
}
