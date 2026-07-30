-- Atomic purchase: Redis runs this as a single uninterruptible unit, so
-- the check and the decrement can never interleave across requests.
-- KEYS[1] = stock counter, KEYS[2] = purchasers set, KEYS[3] = wins stream
-- ARGV[1] = user id, ARGV[2] = sale id
if redis.call('SISMEMBER', KEYS[2], ARGV[1]) == 1 then
  return 'ALREADY_PURCHASED'
end

local stock = tonumber(redis.call('GET', KEYS[1]))
if stock == nil then
  return 'NOT_INITIALIZED'
end
if stock <= 0 then
  return 'SOLD_OUT'
end

redis.call('DECR', KEYS[1])
redis.call('SADD', KEYS[2], ARGV[1])
-- Journal the win in the same atomic unit as the decrement: either all
-- three effects happen or none do, so no dual-write gap is possible.
redis.call('XADD', KEYS[3], '*', 'userId', ARGV[1], 'saleId', ARGV[2])
return 'PURCHASED'
