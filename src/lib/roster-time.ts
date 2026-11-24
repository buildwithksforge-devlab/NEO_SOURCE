/** Resolve a template's wall-clock times in its property's IANA timezone, locally. */
export function rosterShiftWindow(date: string, start: string, end: string, timeZone: string) {
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!day) throw Error('Choose a valid shift date.');
  const [year, month, dayOfMonth] = day.slice(1).map(Number) as [number, number, number];
  const calendar = new Date(Date.UTC(year, month - 1, dayOfMonth));
  if (calendar.toISOString().slice(0, 10) !== date) throw Error('Choose a valid shift date.');
  const seconds = (value: string) => {
    const parts = /^(\d{2}):(\d{2})(?::(\d{2})(?:\.0+)?)?$/.exec(value);
    if (!parts) throw Error('Shift templates need valid start and end times.');
    const h = Number(parts[1]), m = Number(parts[2]), s = Number(parts[3] ?? 0);
    if (h > 23 || m > 59 || s > 59) throw Error('Shift templates need valid start and end times.');
    return h * 3600 + m * 60 + s;
  };
  const startSeconds = seconds(start), endSeconds = seconds(end);
  if (startSeconds === endSeconds) throw Error('Shift start and end times must differ.');
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('en-GB', {timeZone, hourCycle:'h23', year:'numeric',
      month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit'});
  } catch { throw Error('The property timezone is invalid. Correct its regional configuration.'); }
  const wallTime = (instant: number) => {
    const parts = formatter.formatToParts(instant);
    const get = (type: string) => Number(parts.find(part => part.type === type)?.value);
    return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  };
  const resolve = (wall: number) => {
    const offsets = new Set<number>();
    for (let hours = -36; hours <= 36; hours += 6) {
      const probe = wall + hours * 3600000;
      offsets.add(wallTime(probe) - probe);
    }
    const matches = [...offsets].map(offset => wall - offset).filter(candidate => wallTime(candidate) === wall);
    if (matches.length !== 1) throw Error('This shift time is skipped or repeated by a timezone clock change. Choose an unambiguous template time.');
    return new Date(matches[0]!).toISOString();
  };
  return {
    startsAt: resolve(calendar.getTime() + startSeconds * 1000),
    endsAt: resolve(calendar.getTime() + (endSeconds < startSeconds ? 86400000 : 0) + endSeconds * 1000),
  };
}
