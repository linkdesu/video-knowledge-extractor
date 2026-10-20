import argparse, json, os, resource, sys, time, wave
from pathlib import Path

p = argparse.ArgumentParser()
p.add_argument("--audio", required=True)
p.add_argument("--out", required=True)
p.add_argument("--limit", type=float, default=None)
p.add_argument("--hotword", default="")
a = p.parse_args()

import torch
from funasr import AutoModel

root = Path.home() / ".cache/video-notes/models"
os.environ.setdefault("MODELSCOPE_CACHE", str(Path.home() / ".cache/modelscope"))

audio_path = a.audio
tmp_wav = None
if a.limit:
    with wave.open(a.audio, "rb") as w:
        sr = w.getframerate()
        n = int(a.limit * sr)
        frames = w.readframes(n)
        ch = w.getnchannels()
    tmp_wav = str(Path(a.out).parent / f"audio-{int(a.limit)}s.wav")
    Path(a.out).parent.mkdir(parents=True, exist_ok=True)
    with wave.open(tmp_wav, "wb") as w:
        w.setnchannels(ch); w.setsampwidth(2); w.setframerate(sr); w.writeframes(frames)
    audio_path = tmp_wav

t0 = time.time()
model = AutoModel(
    model="iic/speech_seaco_paraformer_large_asr_nat-zh-cn-16k-common-vocab8404-pytorch",
    vad_model="iic/speech_fsmn_vad_zh-cn-16k-common-pytorch",
    punc_model="iic/punc_ct-transformer_zh-cn-common-vocab272727-pytorch",
    spk_model="iic/speech_campplus_sv_zh-cn_16k-common",
    device="cpu",
    disable_update=True,
)
load_s = time.time() - t0

kwargs = dict(input=audio_path, batch_size_s=300, return_spk_res=True, sentence_timestamp=True)
if a.hotword:
    kwargs["hotword"] = a.hotword
t0 = time.time()
res = model.generate(**kwargs)
infer_s = time.time() - t0

items = res[0] if isinstance(res, list) else res
# FunASR may return dict with sentence_info / text, or list of sentence dicts
flat = []
if isinstance(items, dict):
    for sent in items.get("sentence_info", []) or []:
        flat.append(sent)
    if not flat and items.get("text"):
        flat.append({"text": items["text"], "start": 0, "end": a.limit or 0, "spk": 0})
elif isinstance(items, list):
    flat = items

utts = []
for s in flat:
    text = (s.get("text") or "").strip()
    if not text:
        continue
    start = float(s.get("start", 0)) / 1000.0
    end = float(s.get("end", 0)) / 1000.0
    spk = s.get("spk", 0)
    utts.append({"start": start, "end": end, "speaker": f"S{int(spk)+1}", "text": text})
utts.sort(key=lambda x: x["start"])
# merge same speaker adjacent
merged = []
for u in utts:
    if merged and merged[-1]["speaker"] == u["speaker"] and u["start"] - merged[-1]["end"] <= 0.6:
        merged[-1]["end"] = max(merged[-1]["end"], u["end"]); merged[-1]["text"] += u["text"]
    else:
        merged.append(u)

Path(a.out).mkdir(parents=True, exist_ok=True)
run = {
    "provider": "funasr",
    "model": "SeACo-Paraformer-large + fsmn-vad + CT-punc + CAM++",
    "audio": os.path.abspath(a.audio),
    "limit": a.limit,
    "wallSeconds": round(load_s + infer_s, 2),
    "timings": {"load": round(load_s, 2), "inference": round(infer_s, 2)},
    "hotword": a.hotword or None,
    "utterances": len(merged),
    "characters": sum(len(u["text"]) for u in merged),
    "speakers": [{"id": sid, "utterances": sum(1 for u in merged if u["speaker"] == sid), "seconds": round(sum(u["end"]-u["start"] for u in merged if u["speaker"]==sid),1)} for sid in sorted({u["speaker"] for u in merged})],
    "peakRssMB": round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1e6, 1),
}
Path(a.out, "transcript.json").write_text(json.dumps({**run, "utterances": merged, "data": merged}, ensure_ascii=False, indent=1), encoding="utf-8")

def ts(x):
    ms = max(0, int(round(x * 1000))); h=ms//3600000; m=(ms%3600000)//60000; s=(ms%60000)//1000; r=ms%1000
    return f"{h:02d}:{m:02d}:{s:02d},{r:03d}"
with open(Path(a.out, "transcript.srt"), "w", encoding="utf-8") as f:
    for i, u in enumerate(merged, 1):
        f.write(f"{i}\n{ts(u['start'])} --> {ts(u['end'])}\n[{u['speaker']}] {u['text']}\n\n")
Path(a.out, "run.json").write_text(json.dumps(run, ensure_ascii=False, indent=1), encoding="utf-8")
print(json.dumps(run, ensure_ascii=False))
