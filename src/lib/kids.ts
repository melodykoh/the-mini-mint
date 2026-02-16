import { supabase } from './supabase'
import type { Kid } from '../types/database'

export async function getKids(): Promise<Kid[]> {
  const { data, error } = await supabase
    .from('kids')
    .select('*')
    .order('name')
  if (error) throw error
  return data ?? []
}
