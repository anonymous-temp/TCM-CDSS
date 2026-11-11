#!/bin/bash
# 军团工人循环：一个进程一次只做一批。用法：swarm_loop.sh <codex|kimi|dsh> <批号...>
# 任务简报 /var/tmp/r1057/BRIEF.md 第 0 节含禁令：禁止部署、禁止 ssh 到服务器、禁止 git push、禁止读取密钥和 ~/.ssh。
kind=$1; shift
cd /var/tmp/r1057 || exit 1
for b in "$@"; do
  if [ -s "out/$b.json" ] && python3 tools/check_rows.py "out/$b.json" >/dev/null 2>&1 && [ "$(python3 -c "import json;print(len(json.load(open('out/$b.json'))['rows']))")" -ge "$(python3 -c "import json;print(len(json.load(open('batches/$b.json'))['targets']))")" ]; then echo "$(date -u +%T) $kind $b already-done" >> logs/swarm.summary; continue; fi
  P="你是「原方组成」核对员。先完整阅读任务简报 /var/tmp/r1057/BRIEF.md（第 0 节是禁令：禁止部署、禁止 ssh 到服务器、禁止 git push、禁止读取密钥和 ~/.ssh，只在 /var/tmp/r1057 任务目录内工作），然后按简报处理批次 $b：输入 /var/tmp/r1057/batches/$b.json，产出 /var/tmp/r1057/out/$b.json，并用 python3 /var/tmp/r1057/tools/check_rows.py /var/tmp/r1057/out/$b.json 自检到 errors 0。每条组成都必须来自你摘到的原文，不要凭记忆写；输入约 110KB，请用 python 逐条取；每完成约 10 条落盘一次。简报第 5 节要求的总结写进 /var/tmp/r1057/reports/$b.md。"
  start=$(date +%s)
  case $kind in
    codex) codex exec -m gpt-6.1-sol -c model_reasoning_effort=medium --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check -C /var/tmp/r1057 "$P" </dev/null > "logs/codex-$b.log" 2>&1 ;;
    kimi) kimi -m kimi-code/k3.1-pro --auto --add-dir /var/tmp/r1057 -p "$P" </dev/null > "logs/kimi-$b.log" 2>&1 || kimi -m kimi-code/k3.1-pro -p "$P" --output-format stream-json </dev/null >> "logs/kimi-$b.log" 2>&1 ;;
    dsh) dsh-worker --json "$P" </dev/null > "logs/dsh-$b.log" 2>&1 ;;
  esac
  rc=$?
  chk=$(python3 tools/check_rows.py "out/$b.json" 2>&1 | tail -1)
  echo "$(date -u +%T) $kind $b rc=$rc secs=$(( $(date +%s) - start )) check=[$chk]" >> logs/swarm.summary
done
echo "$(date -u +%T) $kind LOOPDONE $*" >> logs/swarm.summary
