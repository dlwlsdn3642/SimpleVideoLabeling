# ========= Base: CUDA Runtime =========
FROM nvidia/cuda:12.1.1-cudnn8-runtime-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

# 필수 런타임 도구 + ffmpeg (OpenCV/프레임 추출용)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg ca-certificates curl tini \
 && rm -rf /var/lib/apt/lists/*

# ========= micromamba (conda 대체, 경량) =========
ENV MAMBA_ROOT_PREFIX=/opt/conda
RUN curl -L https://micro.mamba.pm/api/micromamba/linux-64/latest | tar -xj -C /usr/local/bin/ --strip-components=1 bin/micromamba
SHELL ["/bin/bash", "-lc"]

# ========= conda env (원작자 스펙) =========
# python 3.7, pytorch 1.5, torchvision 0.6.1, cudatoolkit 10.2
RUN micromamba create -y -n transt -c pytorch -c conda-forge \
    python=3.7 \
    pytorch=1.5 torchvision=0.6.1 cudatoolkit=10.2 \
    matplotlib pandas tqdm cython scipy pip \
 && micromamba clean -a -y

# ========= pip / apt 패키지 =========
# libturbojpeg은 apt에서 설치
RUN apt-get update && apt-get install -y --no-install-recommends libturbojpeg && rm -rf /var/lib/apt/lists/*

# pip로 필요한 패키지들 설치
RUN micromamba run -n transt pip install \
    opencv-python \
    tb-nightly visdom scikit-image tikzplotlib gdown \
    pycocotools jpeg4py wget yacs \
    shapely==1.6.4.post2

RUN mkdir -p /home/cx/detr-tracking/pytracking/networks/
RUN gdown --id "1GYpf_YaWLpGva3HB9skDH4H6IFtSERyb" -O /home/cx/detr-tracking/pytracking/networks/transt.pth;

# ========= 앱 복사 =========
WORKDIR /app
COPY transt_server.py /app
COPY transt_wrapper.py /app


# 성능/안정화 환경변수
ENV OMP_NUM_THREADS=1 \
    MKL_NUM_THREADS=1 \
    CUDA_LAUNCH_BLOCKING=0
EXPOSE 7000
ENTRYPOINT ["/usr/bin/tini", "--"]

CMD ["micromamba", "run", "-n", "transt", "uvicorn", "transt_server:app", "--host", "0.0.0.0", "--port", "7000"]