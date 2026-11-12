// The one place that touches console. Swap the body here to change logging everywhere.

type Level = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_ORDER: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 }

function minimumLevel(): Level {
  const configured = process.env.SATCHEL_LOG_LEVEL
  if (configured && configured in LEVEL_ORDER) return configured as Level
  return 'info'
}

function write(level: Level, message: string, fields?: Record<string, unknown>) {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[minimumLevel()]) return
  const suffix = fields ? ` ${JSON.stringify(fields)}` : ''
  console.error(`${new Date().toISOString()} ${level} ${message}${suffix}`)
}

export const log = {
  debug: (message: string, fields?: Record<string, unknown>) => write('debug', message, fields),
  info: (message: string, fields?: Record<string, unknown>) => write('info', message, fields),
  warn: (message: string, fields?: Record<string, unknown>) => write('warn', message, fields),
  error: (message: string, fields?: Record<string, unknown>) => write('error', message, fields),
}
