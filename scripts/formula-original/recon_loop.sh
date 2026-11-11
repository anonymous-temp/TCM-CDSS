#!/bin/bash
# 对账裁决工人循环（Codex）。简报 /var/tmp/r1057/BRIEF-RECON.md 第 0 节含禁令：禁止部署、禁止 ssh 到服务器、禁止 git push、禁止读取密钥和 ~/.ssh。
cd /var/tmp/r1057 || exit 1
for b in "$@"; do
  P="你是方剂「原方组成」对账裁决员。先完整阅读任务简报 /var/tmp/r1057/BRIEF-RECON.md（第 0 节是禁令：禁止部署、禁止 ssh 到服务器、禁止 git push、禁止读取密钥和 ~/.ssh，只在 /var/tmp/r1057 任务目录内工作），需要时参看 /var/tmp/r1057/BRIEF.md 第 3 节的行格式。然后处理批次 $b：输入 /var/tmp/r1057/recon/batches/$b.json，产出 /var/tmp/r1057/recon/out/$b.json，用 python3 /var/tmp/r1057/tools/check_recon.py /var/tmp/r1057/recon/out/$b.json 自检到 errors 0。每条都要回到原文核对后再裁决。总结写进 /var/tmp/r1057/recon/reports/$b.md。"
  start=$(date +%s)
  codex exec -m gpt-6.1-sol -c model_reasoning_effort=high --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check -C /var/tmp/r1057 "$P" </dev/null > "logs/codex-recon-$b.log" 2>&1
  echo "$(date -u +%T) codex-recon $b rc=$? secs=$(( $(date +%s) - start )) check=[$(python3 tools/check_recon.py recon/out/$b.json 2>&1 | tail -1)]" >> logs/swarm.summary
done
echo "$(date -u +%T) codex-recon LOOPDONE $*" >> logs/swarm.summary
