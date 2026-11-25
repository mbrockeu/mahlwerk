// models.py: CatalogItem (the answer), CatalogRef (the request), CatalogInfo.
import { z } from 'zod';
import type { Extra } from '../nutrients.ts';
import type { Per100Key } from '../nutrition.ts';
import { pyStr, type Unit } from './common.ts';

export interface CatalogItem {
  source: 'openfoodfacts' | 'bls';
  code: string;
  name: string;
  name_en: string | null;
  brand: string | null;
  quantity: string | null;
  serving_size: string | null;
  serving_quantity: number | null;
  unit: Unit;
  per_100: Record<Per100Key, number | null>;
  extra: Extra;
  complete: boolean;
}

export const catalogRef = z.object({ source: z.enum(['openfoodfacts', 'bls']), code: pyStr(1, 64) });
export interface CatalogSourceInfo { products: number; updated_at: number | null }
export type CatalogInfo = CatalogSourceInfo & { bls: CatalogSourceInfo };
