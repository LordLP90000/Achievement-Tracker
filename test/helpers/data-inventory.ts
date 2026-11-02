import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { z } from 'zod';

/** `docs/privacy/data-inventory.yaml`, parsed strictly (R-PRIV-08): read by the guard test and the export test. */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const deletionSchema = z.enum(['cascade', 'purge-job', 'consent-withdrawal', 'not-applicable']);
const exportSchema = z.enum(['included', 'excluded']);
const approval = {
  approved_by: z.literal('PM').optional(),
  approved_on: z.string().regex(ISO_DATE).optional(),
};
const columnSchema = z.strictObject({
  category: z.string().regex(/^C(?:[1-9]|1[0-5])$/),
  personal: z.boolean(),
  encrypted: z.boolean().optional(),
  export: exportSchema.optional(),
  export_reason: z.string().min(3).optional(),
  deletion: deletionSchema.optional(),
  deletion_reason: z.string().min(3).optional(),
  retention: z.string().min(3).optional(),
  ...approval,
});
const tableSchema = z.strictObject({
  user_relation: z.string().min(1),
  deletion: deletionSchema.optional(),
  deletion_reason: z.string().min(3).optional(),
  retention: z.string().min(3).optional(),
  ...approval,
  columns: z.record(z.string(), columnSchema),
});
/** Strict: a misspelled key (`exprot: excluded`) fails instead of silently dropping a rule. */
export const inventorySchema = z.strictObject({
  version: z.number().int(),
  updated: z.string().regex(ISO_DATE),
  defaults: z.strictObject({ export: exportSchema, deletion: deletionSchema, retention: z.string().min(3) }),
  tables: z.record(z.string(), tableSchema),
});

export type Inventory = z.infer<typeof inventorySchema>;

export const rawInventory = (): unknown => parse(readFileSync('docs/privacy/data-inventory.yaml', 'utf8'));

export const loadInventory = (): Inventory => inventorySchema.parse(rawInventory());

/** The table's columns the export must contain: those marked `included`, explicitly or by default. */
export function includedColumns(inventory: Inventory, table: string): string[] {
  const columns = inventory.tables[table]?.columns ?? {};
  return Object.entries(columns)
    .filter(([, column]) => (column.export ?? inventory.defaults.export) === 'included')
    .map(([name]) => name);
}
