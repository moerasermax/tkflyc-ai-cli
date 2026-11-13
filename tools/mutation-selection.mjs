const platforms = new Set(['aix','android','darwin','freebsd','haiku','linux','netbsd','openbsd','sunos','win32','cygwin']);
/** Validate even skipped mutations: a typo or stale source must never disappear. */
export function selectMutations(selected, platform, readSource) {
  const runnable=[], skipped=[];
  for (const m of selected) {
    if (m.platforms !== undefined && (!Array.isArray(m.platforms) || !m.platforms.length || m.platforms.some(p=>!platforms.has(p)))) throw Error('invalid platforms: '+m.name);
    const source=readSource(m.file).replaceAll('\r\n','\n'), from=m.from?.replaceAll('\r\n','\n');
    if (!from || source.split(from).length !== 2) throw Error('from must occur exactly once: '+m.name);
    (m.platforms && !m.platforms.includes(platform) ? skipped : runnable).push(m);
  }
  return {runnable,skipped};
}
