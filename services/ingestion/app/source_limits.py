import gzip
from fastapi import HTTPException, UploadFile
from io import BytesIO

from . import config


def source_too_large_error() -> HTTPException:
    return HTTPException(413, f"O arquivo passa do limite de {config.maximum_source_bytes // (1024 * 1024)} MB. Divida a planilha em arquivos menores e tente novamente.")

def ensure_source_size(byte_count: int) -> None:
    if byte_count > config.maximum_source_bytes:
        raise source_too_large_error()

async def read_upload(file: UploadFile) -> bytes:
    source_content = await file.read(config.maximum_source_bytes + 1)
    ensure_source_size(len(source_content))
    return source_content

def bounded_gzip_decompress(source_content: bytes) -> bytes:
    with gzip.GzipFile(fileobj=BytesIO(source_content)) as compressed_file:
        decompressed_content = compressed_file.read(config.maximum_source_bytes + 1)
    ensure_source_size(len(decompressed_content))
    return decompressed_content
