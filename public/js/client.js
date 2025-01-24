import { Device } from "mediasoup-client";

class VideoChat {
  constructor() {
    this.socket = io({
      secure: true,
      rejectUnauthorized: false,
    });
    this.device = null;
    this.producerTransport = null;
    this.consumerTransport = null;
    this.producers = new Map();
    this.consumers = new Map();
    this.isProducing = false;
    this.roomId = "room1";

    this.localVideo = null;
    this.localStream = null;
    this.isMuted = false;
    this.isVideoOff = false;

    this.initializeElements();
    this.addSocketListeners();
  }

  initializeElements() {
    this.videoContainer = document.getElementById("videoContainer");
    this.joinBtn = document.getElementById("joinBtn");
    this.muteBtn = document.getElementById("muteBtn");
    this.videoBtn = document.getElementById("videoBtn");
    this.leaveBtn = document.getElementById("leaveBtn");

    this.joinBtn.addEventListener("click", () => this.joinRoom());
    this.muteBtn.addEventListener("click", () => this.toggleMute());
    this.videoBtn.addEventListener("click", () => this.toggleVideo());
    this.leaveBtn.addEventListener("click", () => this.leaveRoom());
  }

  addSocketListeners() {
    this.socket.on("connect", () => {
      console.log("소켓 연결됨");
    });

    this.socket.on("newProducer", async ({ producerId, peerId, kind }) => {
      console.log("새로운 프로듀서:", producerId, peerId, kind);
      await this.consume(producerId, peerId, kind);
    });

    this.socket.on("peerClosed", ({ peerId }) => {
      console.log("피어 연결 종료:", peerId);
      this.removeVideoElement(peerId);
    });
  }

  async joinRoom() {
    try {
      // 먼저 미디어 권한 요청
      this.localStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: {
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 30 },
        },
      });

      // 로컬 비디오 표시
      this.displayLocalVideo();

      // 1. 방 참가
      const { ok, producerList } = await this.emitWithPromise("joinRoom", {
        roomId: this.roomId,
      });
      if (!ok) throw new Error("방 참가 실패");

      const socket = this.socket;

      // 2. Device 로드 - 수정된 부분
      const getRtpCap = function () {
        return new Promise((resolve) => {
          socket.emit("getRouterRtpCapabilities", (routerRtpCapabilities) => {
            if (!routerRtpCapabilities.error) {
              console.log(`RTP cap = ${routerRtpCapabilities}`);
              resolve(routerRtpCapabilities);
            } else {
              setTimeout(this.response, 1000);
            }
          });
        });
      };
      const response = await getRtpCap();

      console.log(`response = ${response}`);
      if (!response || !response.ok) {
        throw new Error("RTP Capabilities 가져오기 실패");
      }

      this.device = new Device();
      await this.device.load({
        routerRtpCapabilities: response.routerRtpCapabilities,
      });

      // 3. Transport 생성 및 연결
      await this.createProducerTransport();
      await this.createConsumerTransport();

      // 4. Producer 생성
      await this.produce("video");
      await this.produce("audio");

      // 5. 기존 Producer 소비
      for (const { producerId, peerId, kind } of producerList) {
        await this.consume(producerId, peerId, kind);
      }

      this.joinBtn.disabled = true;
    } catch (error) {
      console.error("방 참가 중 오류:", error);
      alert("오류가 발생했습니다: " + error.message);
    }
  }

  async createProducerTransport() {
    const { ok, params } = await this.emitWithPromise("createWebRtcTransport", {
      sender: true,
    });
    if (!ok) throw new Error("Producer Transport 생성 실패");

    this.producerTransport = this.device.createSendTransport(params);

    this.producerTransport.on(
      "connect",
      async ({ dtlsParameters }, callback, errback) => {
        try {
          await this.emitWithPromise("connectTransport", {
            transportId: this.producerTransport.id,
            dtlsParameters,
          });
          callback();
        } catch (error) {
          errback(error);
        }
      }
    );

    this.producerTransport.on(
      "produce",
      async ({ kind, rtpParameters }, callback, errback) => {
        try {
          const { ok, id } = await this.emitWithPromise("produce", {
            transportId: this.producerTransport.id,
            kind,
            rtpParameters,
          });
          callback({ id });
        } catch (error) {
          errback(error);
        }
      }
    );
  }

  async createConsumerTransport() {
    const { ok, params } = await this.emitWithPromise("createWebRtcTransport", {
      sender: false,
    });
    if (!ok) throw new Error("Consumer Transport 생성 실패");

    this.consumerTransport = this.device.createRecvTransport(params);

    this.consumerTransport.on(
      "connect",
      async ({ dtlsParameters }, callback, errback) => {
        try {
          await this.emitWithPromise("connectTransport", {
            transportId: this.consumerTransport.id,
            dtlsParameters,
          });
          callback();
        } catch (error) {
          errback(error);
        }
      }
    );
  }

  async produce(kind) {
    const track =
      kind === "video"
        ? this.localStream.getVideoTracks()[0]
        : this.localStream.getAudioTracks()[0];

    const producer = await this.producerTransport.produce({
      track,
      encodings:
        kind === "video"
          ? [
              { maxBitrate: 100000 },
              { maxBitrate: 300000 },
              { maxBitrate: 900000 },
            ]
          : undefined,
    });

    this.producers.set(kind, producer);

    producer.on("trackended", () => {
      console.log("track ended");
    });

    producer.on("transportclose", () => {
      console.log("transport closed");
    });
  }

  async consume(producerId, peerId, kind) {
    const { ok, params } = await this.emitWithPromise("consume", {
      transportId: this.consumerTransport.id,
      producerId,
      rtpCapabilities: this.device.rtpCapabilities,
    });

    if (!ok) throw new Error("Consumer 생성 실패");

    const consumer = await this.consumerTransport.consume(params);
    this.consumers.set(consumer.id, consumer);

    const mediaStream = new MediaStream([consumer.track]);
    this.displayRemoteVideo(mediaStream, peerId, kind);
    console.log(`mediaStream = ${mediaStream}`);
    console.log(`consumer.track = ${consumer.track}`);

    // await this.emitWithPromise("resume");
    await consumer.resume();
  }

  displayLocalVideo() {
    const videoWrapper = document.createElement("div");
    videoWrapper.className = "video-wrapper";
    videoWrapper.id = "local";

    const video = document.createElement("video");
    video.srcObject = this.localStream;
    video.autoplay = true;
    video.playsInline = true;
    video.muted = true; // 로컬 비디오는 음소거

    videoWrapper.appendChild(video);
    this.videoContainer.appendChild(videoWrapper);
    this.localVideo = video;
  }

  displayRemoteVideo(stream, peerId, kind) {
    let videoWrapper = document.getElementById(`peer-${peerId}`);

    if (!videoWrapper) {
      videoWrapper = document.createElement("div");
      videoWrapper.className = "video-wrapper";
      videoWrapper.id = `peer-${peerId}`;

      const video = document.createElement("video");
      video.autoplay = true;
      video.playsInline = true;

      videoWrapper.appendChild(video);
      this.videoContainer.appendChild(videoWrapper);
    }

    const video = videoWrapper.querySelector("video");
    if (kind === "video") {
      video.srcObject = stream;
    } else {
      // 오디오 스트림을 기존 비디오 스트림과 합치기
      const existingStream = video.srcObject;
      if (existingStream) {
        existingStream.addTrack(stream.getAudioTracks()[0]);
      }
    }
  }

  removeVideoElement(peerId) {
    const videoWrapper = document.getElementById(`peer-${peerId}`);
    if (videoWrapper) {
      videoWrapper.remove();
    }
  }

  toggleMute() {
    const audioTrack = this.localStream.getAudioTracks()[0];
    if (audioTrack) {
      audioTrack.enabled = !audioTrack.enabled;
      this.isMuted = !audioTrack.enabled;
      this.muteBtn.textContent = this.isMuted ? "음소거 해제" : "음소거";
    }
  }

  toggleVideo() {
    const videoTrack = this.localStream.getVideoTracks()[0];
    if (videoTrack) {
      videoTrack.enabled = !videoTrack.enabled;
      this.isVideoOff = !videoTrack.enabled;
      this.videoBtn.textContent = this.isVideoOff
        ? "비디오 켜기"
        : "비디오 끄기";
    }
  }

  async leaveRoom() {
    // Transport 정리
    if (this.producerTransport) {
      this.producerTransport.close();
    }
    if (this.consumerTransport) {
      this.consumerTransport.close();
    }

    // 스트림 정리
    if (this.localStream) {
      this.localStream.getTracks().forEach((track) => track.stop());
    }

    // 비디오 요소 제거
    this.videoContainer.innerHTML = "";

    // 소켓 연결 해제
    this.socket.disconnect();

    // 버튼 상태 초기화
    this.joinBtn.disabled = false;
  }

  emitWithPromise(event, data = {}) {
    return new Promise((resolve) => {
      this.socket.emit(event, data, resolve);
    });
  }
}

// 페이지 로드 시 VideoChat 인스턴스 생성
window.addEventListener("load", () => {
  window.videoChat = new VideoChat();
});
