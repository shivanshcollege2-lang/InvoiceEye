export const MAX_BATCH_CONCURRENCY = 3;

export async function runWithConcurrency(items, worker, concurrency = MAX_BATCH_CONCURRENCY) {
  if (!Array.isArray(items) || typeof worker !== 'function') throw new TypeError('A list and worker function are required.');
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > MAX_BATCH_CONCURRENCY) {
    throw new RangeError(`Concurrency must be between 1 and ${MAX_BATCH_CONCURRENCY}.`);
  }
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length:Math.min(concurrency,items.length) },async()=>{
    while(cursor<items.length){
      const index=cursor++;
      try { results[index]={ value:await worker(items[index],index) }; }
      catch(error) { results[index]={ error }; }
    }
  });
  await Promise.all(workers);
  return results;
}