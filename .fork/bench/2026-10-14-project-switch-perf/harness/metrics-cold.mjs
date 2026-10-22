// Cold-visit host-log correlation v2: multi-line-aware marker matching.
import { readFileSync, writeFileSync } from 'node:fs';

const config = process.argv[2] || 'unknown';
const bench = JSON.parse(readFileSync('/tmp/zcode-prof/bench-cold-out.json', 'utf8'));
const rawLines = readFileSync('/tmp/zcode-app.log', 'utf8').split('\n');

// parse with 4-line lookahead joined into rest (multi-line JSON payloads)
const lines = [];
for (let i = 0; i < rawLines.length; i++) {
  if (rawLines[i].includes('[host-log]')) continue;
  const m = rawLines[i].match(/^\[\d{4}-\d{2}-\d{2} (\d{2}:\d{2}:\d{2}\.\d{3})\] \[pid:\d+\] \[([a-z-]+)\] (.*)$/);
  if (!m) continue;
  lines.push({
    t: new Date(`2026-10-14T${m[1]}+08:00`).getTime(),
    tag: m[2],
    rest: [m[3], ...rawLines.slice(i + 1, i + 7)].join(' '),
  });
}

const visits = bench.visits.map((v) => {
  const targetPath = bench.targets.find((t) => t.split('/').pop() === v.target);
  const window = [v.hoverWall - 4000, v.wallClick + 25000];
  const inWin = (l) => l.t >= window[0] && l.t <= window[1];
  const prepStart = lines.filter(
    (l) => inWin(l) && l.rest.includes('workspace prepare start') && l.rest.includes(targetPath),
  );
  const hostRead = lines.filter(
    (l) => inWin(l) && l.rest.includes('workspace/readPresentation') && l.rest.includes(targetPath),
  );
  const readDone = lines.filter(
    (l) => inWin(l) && l.rest.includes('readWorkspacePresentation done') && l.rest.includes(targetPath),
  );
  const spawn = lines.filter(
    (l) => inWin(l) && l.rest.includes('agent process started') && l.rest.includes(targetPath),
  );
  const readDur = readDone.length
    ? Number(readDone[readDone.length - 1].rest.match(/"readPresentationDurationMs":(\d+)/)?.[1] ?? 0)
    : null;
  return {
    ...v,
    prepareStartOffsetMs: prepStart.length ? prepStart[0].t - v.wallClick : null,
    hostReadOffsetMs: hostRead.length ? hostRead[0].t - v.wallClick : null,
    readPresentationDurMs: readDur,
    spawnedAgent: spawn.length > 0,
    prepareCount: prepStart.length,
    hostReadCount: hostRead.length,
  };
});

const result = {
  config,
  targets: bench.targets,
  visits,
  summary: {
    triggerMs: visits.map((v) => (v.timedOut ? 'timeout' : v.triggerDeltaWall)),
    prepareStartOffsetMs: visits.map((v) => v.prepareStartOffsetMs),
    hostReadOffsetMs: visits.map((v) => v.hostReadOffsetMs),
    readPresentationDurMs: visits.map((v) => v.readPresentationDurMs),
    spawned: visits.map((v) => v.spawnedAgent),
    killed: visits.map((v) => v.killedAgents),
  },
};
writeFileSync(`/tmp/zcode-prof/metrics-cold-${config}.json`, JSON.stringify(result, null, 1));
console.log(JSON.stringify(result.summary));
