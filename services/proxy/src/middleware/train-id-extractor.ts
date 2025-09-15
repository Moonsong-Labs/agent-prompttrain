import { Context, Next } from 'hono';

const TRAIN_ID_HEADER = 'X-TRAIN-ID';
const DEFAULT_TRAIN_ID = 'default';

export const trainIdExtractor = async (c: Context, next: Next) => {
  const trainId = c.req.header(TRAIN_ID_HEADER) || DEFAULT_TRAIN_ID;
  
  c.set('trainId', trainId);
  
  await next();
};