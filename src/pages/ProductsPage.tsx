import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { Eye, FolderTree, ImagePlus, Package, Pencil, Plus, Power, PowerOff, Tags, Trash2, X } from 'lucide-react';
import {
  createProduct,
  deleteCategory,
  deleteProduct,
  listMovements,
  listProducts,
  PAGE_SIZE,
  productImage,
  setProductActive,
  saveCategory,
  updateProduct,
  type CategoryWithCount,
  type ProductInput,
} from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { code, fmtDate, fmtDateTime, fmtInt, fmtMoney } from '@/lib/format';
import type { ProductRow, StockStatus } from '@/lib/types';
import { useAuth } from '@/auth/AuthProvider';
import { useCategories, useDebounce, useInvalidateInventory, useSettings, useStoreToday, useSupplierOptions, useResettingPage } from '@/hooks/data';
import { Button } from '@/components/ui/Button';
import { Input, Select, Textarea } from '@/components/ui/Field';
import { ConfirmDialog, Modal } from '@/components/ui/Modal';
import { Badge, Card, DetailRow, EmptyState, ErrorState, PageHeader, Pagination, SearchInput, TableWrap } from '@/components/ui/Display';
import { imageFileToAvatar } from '@/lib/image';
import { LoadingBlock } from '@/components/ui/Spinner';
import { MovementTable } from '@/components/stock/MovementViews';

export function StockStatusBadge({ status }: { status: StockStatus }) {
  if (status === 'out') return <Badge tone="red">Out of stock</Badge>;
  if (status === 'low') return <Badge tone="amber">Low stock</Badge>;
  return <Badge tone="green">In stock</Badge>;
}

export default function ProductsPage() {
  const { can } = useAuth();
  return (
    <div className="space-y-6">
      <PageHeader
        icon={<Package className="size-5" />}
        title="Products"
        description={can.editProducts ? 'Product catalogue: codes, barcodes, prices, suppliers and stock thresholds.' : 'Look up prices and product availability.'}
      />
      <ProductsPanel />
    </div>
  );
}

export function CategoriesPage() {
  return (
    <div className="space-y-6">
      <PageHeader icon={<FolderTree className="size-5" />} title="Categories" description="Group products so they are easier to find at the Point of Sale and in reports." />
      <CategoriesPanel />
    </div>
  );
}

function ProductsPanel() {
  const { can } = useAuth();
  const [params] = useSearchParams();
  const [search, setSearch] = useState('');
  const [categoryId, setCategoryId] = useState<number | null>(null);
  const initialStatus = params.get('status');
  const [status, setStatus] = useState<'all' | StockStatus>(initialStatus === 'low' || initialStatus === 'out' ? initialStatus : 'all');
  const [archived, setArchived] = useState(false);
  const debounced = useDebounce(search);
  const categories = useCategories();
  const qc = useQueryClient();
  const invalidate = useInvalidateInventory();

  const [editing, setEditing] = useState<ProductRow | 'new' | null>(null);
  const [viewing, setViewing] = useState<ProductRow | null>(null);
  const [deleting, setDeleting] = useState<ProductRow | null>(null);
  const [deactivating, setDeactivating] = useState<ProductRow | null>(null);

  const [page, setPage] = useResettingPage([debounced, categoryId, status, archived]);

  const query = useQuery({
    queryKey: ['products', 'list', { debounced, categoryId, status, archived, page }],
    queryFn: () => listProducts({ search: debounced, categoryId, status, archived, page }),
    placeholderData: (prev) => prev,
  });

  const del = useMutation({
    mutationFn: (p: ProductRow) => deleteProduct(p.id),
    onSuccess: async (result, p) => {
      toast.success(result === 'archived' ? `"${p.name}" has stock history, so it was deactivated instead of deleted.` : `"${p.name}" was deleted.`);
      setDeleting(null);
      await invalidate();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const toggle = useMutation({
    mutationFn: ({ product, active }: { product: ProductRow; active: boolean }) => setProductActive(product.id, active),
    onSuccess: async (_r, { product, active }) => {
      toast.success(active ? `"${product.name}" reactivated. It can be sold and restocked again.` : `"${product.name}" deactivated. It is hidden from sales and stock-in.`);
      setDeactivating(null);
      await Promise.all([qc.invalidateQueries({ queryKey: ['products'] }), qc.invalidateQueries({ queryKey: ['dashboard'] }), qc.invalidateQueries({ queryKey: ['reports'] })]);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  return (
    <Card
      title={archived ? 'Inactive products' : 'Active products'}
      subtitle="Newest products appear first"
      actions={
        can.addProducts && (
          <Button icon={<Plus className="size-4" />} onClick={() => setEditing('new')}>
            Add product
          </Button>
        )
      }
    >
      <div className="grid gap-3 border-b border-line p-4 sm:grid-cols-2 xl:grid-cols-[2fr_1fr_1fr_auto]">
        <SearchInput value={search} onChange={setSearch} placeholder="Search name, SKU, barcode or category…" />
        <select className="input" value={categoryId ?? ''} onChange={(e) => setCategoryId(e.target.value ? Number(e.target.value) : null)} aria-label="Filter by category">
          <option value="">All categories</option>
          {categories.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select className="input" value={status} onChange={(e) => setStatus(e.target.value as typeof status)} aria-label="Filter by stock status">
          <option value="all">All stock levels</option>
          <option value="ok">In stock</option>
          <option value="low">Low stock</option>
          <option value="out">Out of stock</option>
        </select>
        <label className="flex items-center gap-2 text-sm text-muted">
          <input type="checkbox" className="size-4 accent-brand-700" checked={archived} onChange={(e) => setArchived(e.target.checked)} />
          Show inactive
        </label>
      </div>
      {query.isError ? (
        <ErrorState error={errorMessage(query.error)} onRetry={() => query.refetch()} />
      ) : query.isLoading ? (
        <LoadingBlock />
      ) : !query.data?.rows.length ? (
        <EmptyState
          title={debounced || categoryId || status !== 'all' ? 'No matching products' : archived ? 'No inactive products' : 'No products yet'}
          message={can.addProducts && !archived ? 'Add your first product to start tracking inventory.' : undefined}
          action={can.addProducts && !archived && !debounced ? <Button icon={<Plus className="size-4" />} onClick={() => setEditing('new')}>Add product</Button> : undefined}
        />
      ) : (
        <TableWrap>
          <table className="table-base" data-testid="products-table">
            <thead>
              <tr>
                <th>Product</th>
                <th>Category</th>
                <th className="num">Stock</th>
                <th className="num">Min</th>
                <th>Status</th>
                {can.viewCostPrices && <th className="num">Cost</th>}
                <th className="num">Price</th>
                <th>Added</th>
                <th><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {query.data.rows.map((p) => (
                <tr key={p.id}>
                  <td className="min-w-48">
                    <button type="button" className="text-left font-medium text-ink hover:text-brand-700 hover:underline" onClick={() => setViewing(p)}>
                      {p.name}
                    </button>
                    <span className="block text-xs text-muted">{p.sku}{p.barcode ? ` · ${p.barcode}` : ''}</span>
                  </td>
                  <td className="whitespace-nowrap">{p.category_name}</td>
                  <td className="num font-semibold">{fmtInt(p.current_stock)} <span className="text-xs font-normal text-muted">{p.unit}</span></td>
                  <td className="num text-muted">{fmtInt(p.min_stock_level)}</td>
                  <td>{p.is_archived ? <Badge tone="slate"><PowerOff className="size-3" /> Inactive</Badge> : <StockStatusBadge status={p.stock_status} />}</td>
                  {can.viewCostPrices && <td className="num">{fmtMoney(p.purchase_price)}</td>}
                  <td className="num">{fmtMoney(p.selling_price)}</td>
                  <td className="text-xs whitespace-nowrap text-muted">{fmtDate(p.created_at)}</td>
                  <td className="text-right whitespace-nowrap">
                    <Button variant="ghost" size="icon" onClick={() => setViewing(p)} aria-label={`View ${p.name}`}><Eye className="size-4" /></Button>
                    {can.editProducts && !p.is_archived && (
                      <Button variant="ghost" size="icon" onClick={() => setEditing(p)} aria-label={`Edit ${p.name}`}><Pencil className="size-4" /></Button>
                    )}
                    {can.editProducts && !p.is_archived && (
                      <Button variant="ghost" size="icon" className="hover:text-amber-700" onClick={() => setDeactivating(p)} aria-label={`Deactivate ${p.name}`} title="Deactivate"><PowerOff className="size-4" /></Button>
                    )}
                    {can.deleteProducts && !p.is_archived && (
                      <Button variant="ghost" size="icon" className="hover:text-red-600" onClick={() => setDeleting(p)} aria-label={`Delete ${p.name}`}><Trash2 className="size-4" /></Button>
                    )}
                    {can.editProducts && p.is_archived && (
                      <Button
                        variant="secondary"
                        size="sm"
                        icon={<Power className="size-4" />}
                        loading={toggle.isPending && toggle.variables?.product.id === p.id}
                        onClick={() => toggle.mutate({ product: p, active: true })}
                      >
                        Reactivate
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}
      <Pagination page={page} pageSize={PAGE_SIZE} total={query.data?.total ?? 0} onChange={setPage} />

      {editing && <ProductFormModal product={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      {viewing && <ProductDetailModal product={viewing} onClose={() => setViewing(null)} />}
      <ConfirmDialog
        open={Boolean(deactivating)}
        tone="primary"
        title="Deactivate product?"
        message={
          <>
            <b className="text-ink">{deactivating?.name}</b> will be hidden from Stock-In and the Point of Sale and cannot be sold until you reactivate it.
            Its {deactivating ? fmtInt(deactivating.current_stock) : 0} {deactivating?.unit} on hand and its full history are kept, and it still appears in reports.
            Find it later with <b>Show inactive</b>.
          </>
        }
        confirmLabel="Deactivate"
        loading={toggle.isPending}
        onConfirm={() => deactivating && toggle.mutate({ product: deactivating, active: false })}
        onCancel={() => setDeactivating(null)}
      />
      <ConfirmDialog
        open={Boolean(deleting)}
        title="Delete product?"
        message={
          <>
            Remove <b className="text-ink">{deleting?.name}</b>? Products with stock movement history are <b>deactivated</b> (kept for reports) instead of deleted.
            Products that still have stock cannot be removed.
          </>
        }
        confirmLabel="Delete"
        loading={del.isPending}
        onConfirm={() => deleting && del.mutate(deleting)}
        onCancel={() => setDeleting(null)}
      />
    </Card>
  );
}

const productSchema = z
  .object({
    sku: z.string().trim().min(1, 'SKU / product code is required').max(64),
    barcode: z.union([z.literal(''), z.string().trim().regex(/^[A-Za-z0-9._-]{3,64}$/, 'Letters and numbers only (3–64 characters)')]),
    name: z.string().trim().min(1, 'Product name is required').max(150),
    category_id: z.coerce.number<string | number>().int().positive('Select a category'),
    unit: z.string().trim().min(1, 'Unit is required').max(20),
    purchase_price: z.coerce.number<string | number>().min(0, 'Cannot be negative').max(99_999_999),
    selling_price: z.coerce.number<string | number>().min(0, 'Cannot be negative').max(99_999_999),
    min_stock_level: z.coerce.number<string | number>().int('Whole number').min(0, 'Cannot be negative'),
    description: z.string().max(1000).optional(),
    opening_stock: z.coerce.number<string | number>().int('Whole number').min(0, 'Cannot be negative').max(10_000_000),
    supplier_id: z.string().optional(),
  });
type ProductForm = z.input<typeof productSchema>;
type ProductValues = z.output<typeof productSchema>;

function ProductFormModal({ product, onClose }: { product: ProductRow | null; onClose: () => void }) {
  const categories = useCategories();
  const settings = useSettings();
  const suppliers = useSupplierOptions();
  const invalidate = useInvalidateInventory();
  // undefined = keep the saved image, null = remove it, string = new image
  const [image, setImage] = useState<string | null | undefined>(undefined);
  const [currentImage, setCurrentImage] = useState<string | null>(null);
  useEffect(() => {
    if (product?.has_image) void productImage(product.id).then(setCurrentImage);
  }, [product]);
  const shownImage = image === undefined ? currentImage : image;
  const pickImage = async (file: File | undefined) => {
    if (!file) return;
    try {
      setImage(await imageFileToAvatar(file, 320));
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  const { register, handleSubmit, formState } = useForm<ProductForm, unknown, ProductValues>({
    resolver: zodResolver(productSchema),
    defaultValues: product
      ? {
          sku: product.sku,
          name: product.name,
          category_id: product.category_id,
          unit: product.unit,
          purchase_price: product.purchase_price,
          selling_price: product.selling_price,
          min_stock_level: product.min_stock_level,
          description: product.description ?? '',
          opening_stock: 0,
          barcode: product.barcode ?? '',
          supplier_id: product.supplier_id ? String(product.supplier_id) : '',
        }
      : { sku: '', barcode: '', name: '', category_id: '', unit: 'pc', purchase_price: 0, selling_price: 0, min_stock_level: settings.data?.default_min_stock ?? 10, description: '', opening_stock: 0, supplier_id: '' },
  });

  const save = useMutation({
    mutationFn: (v: ProductValues) => {
      const input: ProductInput = { ...v, supplier_id: v.supplier_id ? Number(v.supplier_id) : null, image_url: product ? image : (image ?? null) };
      return product ? updateProduct(product.id, input) : createProduct(input);
    },
    onSuccess: async () => {
      toast.success(product ? 'Product updated.' : 'Product added. It now appears at the top of the list.');
      await invalidate();
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const categoryChanged = product && formState.dirtyFields.category_id;

  return (
    <Modal
      open
      onClose={onClose}
      busy={save.isPending}
      size="lg"
      title={product ? `Edit ${product.name}` : 'Add product'}
      description={product ? 'Stock quantities change only through stock movements.' : 'Opening stock is recorded as a Stock-In movement.'}
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={save.isPending}>Cancel</Button>
          <Button type="submit" form="product-form" loading={save.isPending}>{product ? 'Save changes' : 'Add product'}</Button>
        </>
      }
    >
      <form id="product-form" onSubmit={handleSubmit((v) => save.mutate(v))} className="grid gap-4 sm:grid-cols-2" noValidate>
        <Input label="Product name" required error={formState.errors.name?.message} {...register('name')} wrapperClassName="sm:col-span-2" />
        <Input label="SKU / Product code" required error={formState.errors.sku?.message} {...register('sku')} />
        <Input label="Barcode" placeholder="Scan or type the barcode" error={formState.errors.barcode?.message} {...register('barcode')} />
        <Select label="Category" required error={formState.errors.category_id?.message} {...register('category_id')}>
          <option value="">Select category…</option>
          {categories.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </Select>
        {categoryChanged && (
          <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 sm:col-span-2">
            Changing the category records a category transfer for the units on hand. Past reports keep the original category.
          </p>
        )}
        <Input label="Unit" required placeholder="pc, box, pack, kg…" error={formState.errors.unit?.message} {...register('unit')} />
        <Input label="Minimum stock level" type="number" min={0} step={1} required error={formState.errors.min_stock_level?.message} {...register('min_stock_level')} hint="Alerts trigger at or below this quantity." />
        <Input label="Purchase price" type="number" min={0} step="0.01" error={formState.errors.purchase_price?.message} {...register('purchase_price')} />
        <Input label="Selling price" type="number" min={0} step="0.01" error={formState.errors.selling_price?.message} {...register('selling_price')} />
        <Select label="Supplier" {...register('supplier_id')}>
          <option value="">None</option>
          {suppliers.data?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </Select>
        {!product && (
          <Input label="Opening stock" type="number" min={0} step={1} error={formState.errors.opening_stock?.message} {...register('opening_stock')} hint="Units already on hand (optional)." />
        )}
        <Textarea label="Description" error={formState.errors.description?.message} {...register('description')} wrapperClassName="sm:col-span-2" />
        <div className="flex items-center gap-4 sm:col-span-2">
          {shownImage ? (
            <img src={shownImage} alt="Product" className="size-20 rounded-xl border border-line object-cover" />
          ) : (
            <span className="flex size-20 items-center justify-center rounded-xl border border-dashed border-line text-muted"><ImagePlus className="size-6" /></span>
          )}
          <div className="flex flex-wrap gap-2">
            <label className="inline-flex h-9 cursor-pointer items-center gap-2 rounded-lg border border-line bg-white px-3 text-sm font-medium hover:bg-brand-50">
              <ImagePlus className="size-4" /> {shownImage ? 'Change image' : 'Add product image'}
              <input type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" aria-label="Product image" onChange={(e) => pickImage(e.target.files?.[0])} />
            </label>
            {shownImage && (
              <Button variant="ghost" size="sm" icon={<X className="size-4" />} onClick={() => setImage(null)}>
                Remove image
              </Button>
            )}
          </div>
        </div>
      </form>
    </Modal>
  );
}

function ProductDetailModal({ product, onClose }: { product: ProductRow; onClose: () => void }) {
  const { can } = useAuth();
  const today = useStoreToday();
  const history = useQuery({
    queryKey: ['movements', 'product-detail', product.id],
    queryFn: () => listMovements({ from: '2000-01-01', to: today, productId: product.id, page: 1, pageSize: 10 }),
    enabled: can.viewMovementHistory,
  });
  const image = useQuery({ queryKey: ['products', 'image', product.id], queryFn: () => productImage(product.id), enabled: product.has_image });
  return (
    <Modal open onClose={onClose} size="xl" title={product.name} description={`${code('PRD', product.id)} · SKU ${product.sku}${product.barcode ? ` · Barcode ${product.barcode}` : ''}`}>
      {image.data && <img src={image.data} alt="" className="mb-4 size-28 rounded-xl border border-line object-cover" />}
      <div className="grid gap-6 lg:grid-cols-2">
        <dl className="divide-y divide-line">
          <DetailRow label="Category">{product.category_name}</DetailRow>
          {can.viewSuppliers && <DetailRow label="Supplier">{product.supplier_name ?? '—'}</DetailRow>}
          <DetailRow label="Current stock">{fmtInt(product.current_stock)} {product.unit} <StockStatusBadge status={product.stock_status} /></DetailRow>
          <DetailRow label="Minimum level">{fmtInt(product.min_stock_level)}</DetailRow>
          {can.viewCostPrices && <DetailRow label="Purchase price">{fmtMoney(product.purchase_price)}</DetailRow>}
          <DetailRow label="Selling price">{fmtMoney(product.selling_price)}</DetailRow>
          {can.viewCostPrices && <DetailRow label="Stock value (cost)">{fmtMoney(product.stock_value)}</DetailRow>}
        </dl>
        <dl className="divide-y divide-line">
          <DetailRow label="Description">{product.description || '—'}</DetailRow>
          <DetailRow label="Date added">{fmtDateTime(product.created_at)}</DetailRow>
          <DetailRow label="Last updated">{fmtDateTime(product.updated_at)}</DetailRow>
          <DetailRow label="Status">{product.is_archived ? <Badge tone="slate"><PowerOff className="size-3" /> Inactive</Badge> : <Badge tone="green">Active</Badge>}</DetailRow>
        </dl>
      </div>
      {can.viewMovementHistory && (
        <>
          <h3 className="mt-6 mb-2 text-sm font-semibold">Latest stock movements</h3>
          <div className="rounded-xl border border-line">
            {history.isLoading ? <LoadingBlock rows={3} /> : <MovementTable rows={history.data?.rows ?? []} compact />}
          </div>
        </>
      )}
    </Modal>
  );
}

const categorySchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(80),
  description: z.string().max(500).optional(),
});

function CategoriesPanel() {
  const { can } = useAuth();
  const categories = useCategories();
  const qc = useQueryClient();
  const [editing, setEditing] = useState<CategoryWithCount | 'new' | null>(null);
  const [deleting, setDeleting] = useState<CategoryWithCount | null>(null);

  const del = useMutation({
    mutationFn: (c: CategoryWithCount) => deleteCategory(c.id),
    onSuccess: async () => {
      toast.success('Category deleted.');
      setDeleting(null);
      await qc.invalidateQueries({ queryKey: ['categories'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  return (
    <Card
      title="Product categories"
      subtitle="Newest categories appear first"
      actions={can.manageCategories && <Button icon={<Plus className="size-4" />} onClick={() => setEditing('new')}>Add category</Button>}
    >
      {categories.isError ? (
        <ErrorState error={errorMessage(categories.error)} onRetry={() => categories.refetch()} />
      ) : categories.isLoading ? (
        <LoadingBlock />
      ) : !categories.data?.length ? (
        <EmptyState icon={<Tags className="size-6" />} title="No categories yet" message="Create categories such as Beverages, Food Products, Household Products and Personal Care." />
      ) : (
        <TableWrap>
          <table className="table-base" data-testid="categories-table">
            <thead>
              <tr>
                <th>Category</th>
                <th>Description</th>
                <th className="num">Products</th>
                <th>Created</th>
                {can.manageCategories && <th><span className="sr-only">Actions</span></th>}
              </tr>
            </thead>
            <tbody>
              {categories.data.map((c) => (
                <tr key={c.id}>
                  <td className="font-medium">{c.name}</td>
                  <td className="text-muted">{c.description || '—'}</td>
                  <td className="num">{fmtInt(c.products?.[0]?.count ?? 0)}</td>
                  <td className="text-xs text-muted">{fmtDate(c.created_at)}</td>
                  {can.manageCategories && (
                    <td className="text-right whitespace-nowrap">
                      <Button variant="ghost" size="icon" onClick={() => setEditing(c)} aria-label={`Edit ${c.name}`}><Pencil className="size-4" /></Button>
                      <Button variant="ghost" size="icon" className="hover:text-red-600" onClick={() => setDeleting(c)} aria-label={`Delete ${c.name}`}><Trash2 className="size-4" /></Button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}
      {editing && <CategoryFormModal category={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      <ConfirmDialog
        open={Boolean(deleting)}
        title="Delete category?"
        message={<>Delete <b className="text-ink">{deleting?.name}</b>? Categories that contain products or appear in stock history cannot be deleted.</>}
        confirmLabel="Delete"
        loading={del.isPending}
        onConfirm={() => deleting && del.mutate(deleting)}
        onCancel={() => setDeleting(null)}
      />
    </Card>
  );
}

function CategoryFormModal({ category, onClose }: { category: CategoryWithCount | null; onClose: () => void }) {
  const qc = useQueryClient();
  const { register, handleSubmit, formState } = useForm<z.infer<typeof categorySchema>>({
    resolver: zodResolver(categorySchema),
    defaultValues: { name: category?.name ?? '', description: category?.description ?? '' },
  });
  const save = useMutation({
    mutationFn: (v: z.infer<typeof categorySchema>) => saveCategory({ id: category?.id, ...v }),
    onSuccess: async () => {
      toast.success(category ? 'Category updated.' : 'Category added.');
      await Promise.all([qc.invalidateQueries({ queryKey: ['categories'] }), qc.invalidateQueries({ queryKey: ['products'] })]);
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e).includes('already exists') ? 'A category with this name already exists.' : errorMessage(e)),
  });
  return (
    <Modal
      open
      onClose={onClose}
      busy={save.isPending}
      title={category ? 'Edit category' : 'Add category'}
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={save.isPending}>Cancel</Button>
          <Button type="submit" form="category-form" loading={save.isPending}>Save</Button>
        </>
      }
    >
      <form id="category-form" onSubmit={handleSubmit((v) => save.mutate(v))} className="space-y-4" noValidate>
        <Input label="Category name" required error={formState.errors.name?.message} {...register('name')} />
        <Textarea label="Description" error={formState.errors.description?.message} {...register('description')} />
      </form>
    </Modal>
  );
}
