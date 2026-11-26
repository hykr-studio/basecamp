-- An order's line names a product of its own business (R1, docs/decisions/R1.md). The item spec
-- declares the reference (`traits.references`), which every tree write checks in bulk as the
-- writer; this key is the database's backstop. It points (tenant_id, product_id) at the
-- product's (tenant_id, id) (unique in the orders schema), and a deleted product unlinks only its
-- own business's lines: SET NULL of product_id alone, which drizzle cannot say (Postgres 15+).
-- The column is new with the key, so there is nothing to repair first. Every later migrate finds
-- the key on its own table (conrelid) and skips.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'orders_items_product_fk'
                   AND conrelid = 'app.orders_items'::regclass) THEN
    ALTER TABLE app.orders_items ADD CONSTRAINT orders_items_product_fk
      FOREIGN KEY (tenant_id, product_id) REFERENCES app.orders_products (tenant_id, id)
      ON DELETE SET NULL (product_id);
  END IF;
END $$;
