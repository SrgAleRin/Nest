export function newId(): string {
  return globalThis.crypto.randomUUID();
}

export function nowIso(): string {
  return new Date().toISOString();
}

const translit: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i',
  й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't',
  у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '',
  э: 'e', ю: 'yu', я: 'ya',
};

export function slugify(value: string): string {
  const lower = value.toLowerCase();
  let result = '';
  for (const char of lower) {
    if (translit[char] !== undefined) {
      result += translit[char];
    } else if (/[a-z0-9]/.test(char)) {
      result += char;
    } else {
      result += '-';
    }
  }
  return result.replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'task';
}
