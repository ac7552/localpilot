"""Convert the BF16 tensors in a GGUF file (e.g. a vision mmproj) to F16.

macOS 13 (Ventura) has no Metal bfloat kernels, so llama.cpp aborts when a BF16
vision projector runs on the GPU. F16 runs everywhere.

usage: python bf16_to_f16.py <input.gguf> <output.gguf>
"""
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path.home() / "llama.cpp" / "gguf-py"))
import gguf  # noqa: E402

F16_MAX = 65504.0


def main(src: str, dst: str) -> None:
    reader = gguf.GGUFReader(src)
    arch = reader.fields[gguf.Keys.General.ARCHITECTURE].contents()
    writer = gguf.GGUFWriter(dst, arch=arch, endianess=reader.endianess)

    for field in reader.fields.values():
        if field.name == gguf.Keys.General.ARCHITECTURE or field.name.startswith("GGUF."):
            continue
        val_type = field.types[0]
        sub_type = field.types[-1] if val_type == gguf.GGUFValueType.ARRAY else None
        value = field.contents()
        if field.name == gguf.Keys.General.FILE_TYPE:
            value = int(gguf.LlamaFileType.MOSTLY_F16)
        writer.add_key_value(field.name, value, val_type, sub_type=sub_type)

    converted = {}
    clipped = 0
    for t in reader.tensors:
        if t.tensor_type == gguf.GGMLQuantizationType.BF16:
            raw = np.frombuffer(t.data.tobytes(), dtype=np.uint16)
            f32 = (raw.astype(np.uint32) << 16).view(np.float32)
            clipped += int(np.count_nonzero(np.abs(f32) > F16_MAX))
            shape = list(reversed([int(x) for x in t.shape]))
            arr = np.clip(f32, -F16_MAX, F16_MAX).astype(np.float16).reshape(shape)
            converted[t.name] = arr
            writer.add_tensor_info(t.name, arr.shape, arr.dtype, arr.nbytes, gguf.GGMLQuantizationType.F16)
        else:
            writer.add_tensor_info(t.name, t.data.shape, t.data.dtype, t.data.nbytes, t.tensor_type)

    writer.write_header_to_file()
    writer.write_kv_data_to_file()
    writer.write_ti_data_to_file()
    for t in reader.tensors:
        data = converted.get(t.name)
        writer.write_tensor_data(data if data is not None else t.data, tensor_endianess=reader.endianess)
    writer.close()
    print(f"converted {len(converted)} BF16 tensors to F16 ({clipped} values clipped to the F16 range)")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
