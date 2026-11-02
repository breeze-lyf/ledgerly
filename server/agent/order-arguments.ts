const round = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
function number(value: any, fallback = 0): number {
  const n = Number(value?.value ?? value ?? fallback);
  if (!Number.isFinite(n)) throw Error("Order amounts must be finite numbers");
  return n;
}
export function normalizeOrder(a: any) {
  const unit = a.purchase_units?.[0];
  const currencyCode = String(a.currencyCode || a.currency || a.currency_code || a.amount?.currency_code || unit?.amount?.currency_code || "USD").toUpperCase();
  const description = a.description || a.notes || unit?.description || "Payment";
  const source = a.items?.length ? a.items : unit?.items?.length ? unit.items : [{ name: description, itemCost: a.amount ?? unit?.amount }];
  const items = source.map((i: any) => {
    const quantity = number(i.quantity, 1);
    const itemCost = round(number(i.itemCost ?? i.unit_amount ?? i.price ?? i.amount ?? (i.itemTotal === undefined ? undefined : number(i.itemTotal) / quantity)));
    const taxPercent = number(i.taxPercent ?? a.taxPercent);
    if (!Number.isInteger(quantity) || quantity <= 0 || itemCost < 0 || taxPercent < 0) throw Error("Invalid order item");
    return { name: i.name || description, quantity, itemCost, taxPercent, itemTotal: round(quantity * itemCost) };
  });
  const shippingCost = round(number(a.shippingCost ?? a.shipping_cost));
  const discount = round(number(a.discount));
  const amount = round(items.reduce((s: number, i: any) => s + i.itemTotal + round(i.itemCost * i.taxPercent / 100) * i.quantity, 0) + shippingCost - discount);
  if (shippingCost < 0 || discount < 0 || amount <= 0) throw Error("Order amount must be positive");
  return { currencyCode, items, shippingCost, discount, notes: description, amount };
}
