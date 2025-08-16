FROM ubuntu:18.04

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates git \
    build-essential pkg-config \
    libgl1 libglib2.0-0 \
    libturbojpeg \
    wget \
    && rm -rf /var/lib/apt/lists/*

# ---- conda ----
ENV CONDA_DIR=/opt/conda
RUN curl -fsSL https://repo.anaconda.com/miniconda/Miniconda3-latest-Linux-x86_64.sh -o /tmp/mc.sh \
 && bash /tmp/mc.sh -b -p $CONDA_DIR \
 && rm -f /tmp/mc.sh
ENV PATH=$CONDA_DIR/bin:$PATH

SHELL ["/bin/bash", "-lc"]

ENV CONDA_PLUGINS_AUTO_ACCEPT_TOS=true

RUN conda update -y -n base -c defaults conda && \
    conda create -y -n transt python=3.7 && \
    conda clean -afy

ENV CONDA_DEFAULT_ENV=transt
ENV PATH=$CONDA_DIR/envs/transt/bin:$PATH

RUN conda install -y -n transt -c pytorch \
      pytorch=1.5 torchvision=0.6.1 cudatoolkit=10.2 && \
    conda clean -afy

RUN conda install -y -n transt matplotlib pandas tqdm cython scipy && conda clean -afy && \
    pip install --no-cache-dir \
    opencv-python tb-nightly visdom scikit-image tikzplotlib gdown \
    pycocotools jpeg4py wget yacs fastapi "uvicorn[standard]" && \
    pip install --no-cache-dir "shapely==1.6.4.post2"

# -------- 작업 디렉터리 --------
WORKDIR /root

# -------- TransT 클론 --------
RUN git clone https://github.com/chenxin-dlut/TransT.git
ENV PYTHONPATH=/root/TransT:${PYTHONPATH}

# -------- server.py, tracker_wrapper.py --------
COPY server.py /root/TransT/
COPY tracker_wrapper.py /root/TransT/

# -------- 가중치 --------
RUN mkdir -p /home/cx/detr-tracking/pytracking/networks/
RUN echo "Downloading TransT weight from Google Drive..." && \
    gdown --id "1Pq0sK-9jmbLAVtgB9-dPDc2pipCxYdM5" -O /home/cx/detr-tracking/pytracking/networks/transt.pth;

WORKDIR /root/TransT
EXPOSE 7000

# CUDA 최적화 설정
ENV OMP_NUM_THREADS=1 \
    MKL_NUM_THREADS=1 \
    CUDA_LAUNCH_BLOCKING=0

# uvicorn 서버 기동
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "7000"]