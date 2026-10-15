// Brazilian postal-code (CEP) lookup via the public ViaCEP service.
import { config } from '../config.js';

const cache = new Map();

export async function lookupCep(cep, fetchImpl = fetch) {
  const digits = String(cep || '').replace(/\D/g, '');
  if (digits.length !== 8) return { error: 'CEP must have 8 digits' };
  if (cache.has(digits)) return cache.get(digits);
  const res = await fetchImpl(`${config.viacepUrl}/${digits}/json/`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) return { error: `ViaCEP returned ${res.status}` };
  const data = await res.json();
  if (data.erro) return { error: 'CEP not found' };
  const out = {
    cep: digits,
    street: data.logradouro || '',
    complement: data.complemento || '',
    neighborhood: data.bairro || '',
    city: data.localidade || '',
    state: data.uf || '',
  };
  cache.set(digits, out);
  return out;
}
