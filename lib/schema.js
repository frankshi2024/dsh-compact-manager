/**
 * Storage declaration for dsh-compact-manager.
 *
 * The policy document lives in one key-value domain record, so it survives
 * restarts, is validated on open, and never shows up in the model's context.
 * Domain and table names must match `/^[a-z][a-z0-9_]*$/`.
 */

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'

const itemSchema = z.object({
  enabled: z.boolean(),
  value: z.number(),
}).strict()

const layerSchema = z.object({
  ratio: itemSchema.optional(),
  outputAware: itemSchema.optional(),
  fixed: itemSchema.optional(),
}).strict()

const documentSchema = z.object({
  global: layerSchema,
  tiers: z.array(z.object({
    window: z.number().int().positive(),
    policy: layerSchema,
  }).strict()),
  models: z.array(z.object({
    provider: z.string().min(1),
    model: z.string().min(1),
    policy: layerSchema,
  }).strict()),
}).strict()

const recordSchema = z.object({
  document: documentSchema,
  revision: z.number().int().nonnegative(),
}).strict()

/** Domain identity: bump `version` and migrate when the record shape changes. */
export const compactManagerDomain = defineDomain({
  name: 'compact_manager',
  version: 1,
  tables: { documents: domainTable(recordSchema) },
})

/** The single record key holding the live policy document. */
export const DOCUMENT_KEY = 'current'
