"use strict";

const app = angular.module("didStreamApp", []);

// A service to encapsulate all D-ID API and WebRTC logic
app.service("dIdStreamService", function ($timeout, $q) {
  const self = this;

  // Configuration and State
  let DID_API = {};
  const RTCPeerConnection = (
    window.RTCPeerConnection ||
    window.webkitRTCPeerConnection ||
    window.mozRTCPeerConnection
  ).bind(window);

  const presenterInputByService = {
    talks: {
      source_url:
        "https://create-images-results.d-id.com/DefaultPresenters/Emma_f/v1_image.jpeg",
    },
    clips: {
      presenter_id: "v2_public_alex@qcvo4gupoy",
      driver_id: "e3nbserss8",
    },
  };

  const scriptConfigs = {
    audio: {
      type: "audio",
      audio_url:
        "https://d-id-public-bucket.s3.us-west-2.amazonaws.com/webrtc.mp3",
    },
    text: {
      type: "text",
      provider: { type: "microsoft", voice_id: "en-US-AndrewNeural" },
      input: `Hello, I am an AI interview assisstant and I am here to take your interview. Can you tell me something about yourself ?`,
      ssml: true,
    },
  };

  const stream_warmup = true;
  let peerConnection;
  let pcDataChannel;
  let streamId;
  let sessionId;
  let statsIntervalId;
  let lastBytesReceived;
  let videoIsPlaying = false;

  // Public state exposed to the controller
  this.isStreamReady = !stream_warmup;
  this.streamVideoOpacity = 0;
  this.status = {
    iceGathering: { text: "", className: "" },
    ice: { text: "", className: "" },
    peer: { text: "", className: "" },
    signaling: { text: "", className: "" },
    streaming: { text: "", className: "" },
    streamEvent: { text: "", className: "" },
  };

  // Helper for API calls with retries
  async function fetchWithRetries(url, options, retries = 1) {
    const maxRetryCount = 3;
    const maxDelaySec = 4;
    try {
      return await fetch(url, options);
    } catch (err) {
      if (retries <= maxRetryCount) {
        const delay =
          Math.min(Math.pow(2, retries) / 4 + Math.random(), maxDelaySec) *
          1000;
        console.log(
          `Request failed, retrying ${retries}/${maxRetryCount}. Error ${err}`
        );
        return fetchWithRetries(url, options, retries + 1);
      } else {
        throw new Error(`Max retries exceeded. error: ${err}`);
      }
    }
  }

  // WebRTC Event Handlers
  function onIceGatheringStateChange() {
    // NEW LOG
    console.log(
      "ICE gathering state changed:",
      peerConnection.iceGatheringState
    );
    $timeout(() => {
      self.status.iceGathering.text = peerConnection.iceGatheringState;
      self.status.iceGathering.className =
        "iceGatheringState-" + peerConnection.iceGatheringState;
    });
  }

  function onIceCandidate(event) {
    // NEW LOG
    console.log("onIceCandidate event:", event);
    if (event.candidate) {
      const { candidate, sdpMid, sdpMLineIndex } = event.candidate;
      // NEW LOG
      console.log("Sending ICE candidate to D-ID API");
      fetch(`${DID_API.url}/${DID_API.service}/streams/${streamId}/ice`, {
        method: "POST",
        headers: {
          Authorization: `Basic ${DID_API.key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          candidate,
          sdpMid,
          sdpMLineIndex,
          session_id: sessionId,
        }),
      });
    }
  }

  function onIceConnectionStateChange() {
    // NEW LOG
    console.log(
      "ICE connection state changed:",
      peerConnection.iceConnectionState
    );
    $timeout(() => {
      self.status.ice.text = peerConnection.iceConnectionState;
      self.status.ice.className =
        "iceConnectionState-" + peerConnection.iceConnectionState;
      if (
        peerConnection.iceConnectionState === "failed" ||
        peerConnection.iceConnectionState === "closed"
      ) {
        // NEW LOG
        console.warn("ICE connection failed or closed, closing session.");
        self.close();
      }
    });
  }

  function onConnectionStateChange() {
    // NEW LOG
    console.log(
      "Peer connection state changed:",
      peerConnection.connectionState
    );
    $timeout(() => {
      self.status.peer.text = peerConnection.connectionState;
      self.status.peer.className =
        "peerConnectionState-" + peerConnection.connectionState;
    });
  }

  function onSignalingStateChange() {
    // NEW LOG
    console.log("Signaling state changed:", peerConnection.signalingState);
    $timeout(() => {
      self.status.signaling.text = peerConnection.signalingState;
      self.status.signaling.className =
        "signalingState-" + peerConnection.signalingState;
    });
  }

  function onVideoStatusChange(isPlaying, stream) {
    // NEW LOG
    console.log("Video status changed. Is playing:", isPlaying);
    let statusText;
    if (isPlaying) {
      statusText = "streaming";
      self.streamVideoOpacity = self.isStreamReady ? 1 : 0;
      const streamVideoElement = document.getElementById(
        "stream-video-element"
      );
      if (streamVideoElement && stream) {
        streamVideoElement.srcObject = stream;
        streamVideoElement.loop = false;
        streamVideoElement.mute = !self.isStreamReady;
        if (streamVideoElement.paused)
          streamVideoElement.play().catch((e) => {});
      }
    } else {
      statusText = "empty";
      self.streamVideoOpacity = 0;
    }
    $timeout(() => {
      self.status.streaming.text = statusText;
      self.status.streaming.className = "streamingState-" + statusText;
    });
  }

  function onTrack(event) {
    // NEW LOG
    console.log("onTrack event received:", event);
    if (!event.track) return;

    statsIntervalId = setInterval(async () => {
      const stats = await peerConnection.getStats(event.track);
      stats.forEach((report) => {
        if (report.type === "inbound-rtp" && report.kind === "video") {
          const videoStatusChanged =
            videoIsPlaying !== report.bytesReceived > lastBytesReceived;
          if (videoStatusChanged) {
            videoIsPlaying = report.bytesReceived > lastBytesReceived;
            onVideoStatusChange(videoIsPlaying, event.streams[0]);
          }
          lastBytesReceived = report.bytesReceived;
        }
      });
    }, 500);
  }

  function setStreamReady(ready) {
    // NEW LOG
    console.log("Setting stream ready state to:", ready);
    $timeout(() => {
      self.isStreamReady = ready;
      self.status.streamEvent.text = "ready";
      self.status.streamEvent.className = "streamEvent-ready";
    });
  }

  function onStreamEvent(message) {
    // NEW LOG
    console.log("Data channel event received:", message.data);
    if (pcDataChannel.readyState !== "open") return;

    const [event, _] = message.data.split(":");
    const status = event.replace("stream/", "");

    if (status === "ready") {
      $timeout(() => setStreamReady(true), 1000);
    } else {
      $timeout(() => {
        self.status.streamEvent.text = status;
        self.status.streamEvent.className = `streamEvent-${status}`;
      });
    }
  }

  async function createPeerConnection(offer, iceServers) {
    // NEW LOG
    console.log("Creating new Peer Connection.");
    if (!peerConnection) {
      peerConnection = new RTCPeerConnection({ iceServers });
      pcDataChannel = peerConnection.createDataChannel("JanusDataChannel");
      peerConnection.addEventListener(
        "icegatheringstatechange",
        onIceGatheringStateChange,
        true
      );
      peerConnection.addEventListener("icecandidate", onIceCandidate, true);
      peerConnection.addEventListener(
        "iceconnectionstatechange",
        onIceConnectionStateChange,
        true
      );
      peerConnection.addEventListener(
        "connectionstatechange",
        onConnectionStateChange,
        true
      );
      peerConnection.addEventListener(
        "signalingstatechange",
        onSignalingStateChange,
        true
      );
      peerConnection.addEventListener("track", onTrack, true);
      pcDataChannel.addEventListener("message", onStreamEvent, true);
    }

    await peerConnection.setRemoteDescription(offer);
    // NEW LOG
    console.log("Set remote description OK.");
    const sessionClientAnswer = await peerConnection.createAnswer();
    // NEW LOG
    console.log("Created local answer OK.");
    await peerConnection.setLocalDescription(sessionClientAnswer);
    // NEW LOG
    console.log("Set local description OK.");

    return sessionClientAnswer;
  }

  // Public Service Methods
  this.connect = async () => {
    // NEW LOG
    console.log("Connect method called.");
    if (peerConnection && peerConnection.connectionState === "connected")
      return;

    if (!DID_API.key) {
      // NEW LOG
      console.log("API key not found, fetching from api.json");
      const fetchJsonFile = await fetch("./api.json");
      DID_API = await fetchJsonFile.json();
      if (DID_API.key === "🤫") {
        alert("Please put your api key inside ./api.json and restart..");
        return Promise.reject("API Key not configured");
      }
    }

    self.close();

    // NEW LOG
    console.log("Requesting new stream session from D-ID API...");
    const sessionResponse = await fetchWithRetries(
      `${DID_API.url}/${DID_API.service}/streams`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${DID_API.key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          ...presenterInputByService[DID_API.service],
          stream_warmup,
        }),
      }
    );

    const {
      id: newStreamId,
      offer,
      ice_servers: iceServers,
      session_id: newSessionId,
    } = await sessionResponse.json();
    streamId = newStreamId;
    sessionId = newSessionId;
    // NEW LOG
    console.log("Session created successfully. Stream ID:", streamId);

    const sessionClientAnswer = await createPeerConnection(offer, iceServers);

    // NEW LOG
    console.log("Sending SDP answer to D-ID API.");
    await fetch(`${DID_API.url}/${DID_API.service}/streams/${streamId}/sdp`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${DID_API.key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        answer: sessionClientAnswer,
        session_id: sessionId,
      }),
    });

    return DID_API.service;
  };

  //   this.startStream = async (type) => {
  //     // NEW LOG
  //     console.log(`startStream called with type: ${type}`);
  //     if ((peerConnection?.signalingState === 'stable' || peerConnection?.iceConnectionState === 'connected') && this.isStreamReady) {
  //       // NEW LOG
  //       console.log('Connection is stable and ready, sending stream data.');
  //       await fetchWithRetries(`${DID_API.url}/${DID_API.service}/streams/${streamId}`, {
  //         method: 'POST',
  //         headers: { Authorization: `Basic ${DID_API.key}`, 'Content-Type': 'application/json' },
  //         body: JSON.stringify({
  //           script: scriptConfigs[type],
  //           config: { stitch: true },
  //           session_id: sessionId,
  //           ...(DID_API.service === 'clips' && { background: { color: '#FFFFFF' } }),
  //         }),
  //       });
  //     } else {
  //         console.warn('Cannot start stream: connection not stable or stream not ready.');
  //     }
  //   };

  this.startStream = async (textToSpeak) => {
    // NEW LOG
    console.log(`startStream called with text: "${textToSpeak}"`);

    if (!textToSpeak) {
      console.warn("Cannot start stream: no text provided.");
      return;
    }

    if (
      (peerConnection?.signalingState === "stable" ||
        peerConnection?.iceConnectionState === "connected") &&
      this.isStreamReady
    ) {
      // NEW LOG
      console.log("Connection is stable and ready, sending stream data.");

      // Dynamically create the script with the user's input text
      const script = {
        type: "text",
        provider: { type: "microsoft", voice_id: "en-US-AndrewNeural" }, // You can keep a default provider
        input: textToSpeak,
        ssml: false, // Set to false for plain text from a textarea
      };

      await fetchWithRetries(
        `${DID_API.url}/${DID_API.service}/streams/${streamId}`,
        {
          method: "POST",
          headers: {
            Authorization: `Basic ${DID_API.key}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            script: script, // Use the dynamically created script object
            config: { stitch: true },
            session_id: sessionId,
            ...(DID_API.service === "clips" && {
              background: { color: "#FFFFFF" },
            }),
          }),
        }
      );
    } else {
      console.warn(
        "Cannot start stream: connection not stable or stream not ready."
      );
    }
  };

  this.destroy = async () => {
    // NEW LOG
    console.log("Destroy method called.");
    if (!sessionId) return;
    await fetch(`${DID_API.url}/${DID_API.service}/streams/${streamId}`, {
      method: "DELETE",
      headers: {
        Authorization: `Basic ${DID_API.key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ session_id: sessionId }),
    });
    self.close();
    clearInterval(statsIntervalId);
  };

  this.close = () => {
    // NEW LOG
    console.log("Closing peer connection and cleaning up resources.");
    if (peerConnection) {
      peerConnection.close();
      // Event listeners are removed automatically on close, but this is explicit
      peerConnection = null;
    }
    if (pcDataChannel) {
      pcDataChannel = null;
    }

    clearInterval(statsIntervalId);

    const streamVideoElement = document.getElementById("stream-video-element");
    if (streamVideoElement && streamVideoElement.srcObject) {
      streamVideoElement.srcObject.getTracks().forEach((track) => track.stop());
      streamVideoElement.srcObject = null;
    }

    $timeout(() => {
      this.isStreamReady = !stream_warmup;
      this.streamVideoOpacity = 0;
      Object.keys(this.status).forEach((key) => {
        this.status[key] = { text: "", className: "" };
      });
    });

    sessionId = null;
    streamId = null;
  };
});

app.controller("MainController", function ($scope, dIdStreamService, $sce) {
  // NEW: state for loading indicator
  $scope.isLoading = false;

  $scope.status = dIdStreamService.status;
  $scope.idleVideoUrl = "";

  // Watcher for stream readiness to hide the loader
  $scope.$watch(
    () => dIdStreamService.isStreamReady,
    (isReady) => {
      // NEW LOG
      console.log("Controller detected isStreamReady changed to:", isReady);
      if (isReady) {
        $scope.isLoading = false;
      }
    }
  );

  $scope.$watch(
    () => dIdStreamService.streamVideoOpacity,
    (newVal) => {
      $scope.streamVideoOpacity = newVal;
    }
  );

  $scope.connect = async () => {
    // NEW LOG
    console.log("UI connect button clicked.");
    // NEW: Show loader
    $scope.isLoading = true;

    try {
      const serviceType = await dIdStreamService.connect();
      if (serviceType) {
        const videoUrl =
          serviceType === "clips" ? "alex_v2_idle.mp4" : "emma_idle.mp4";
        $scope.idleVideoUrl = $sce.trustAsResourceUrl(videoUrl);
        $scope.$apply();
      }
    } catch (error) {
      // NEW: Hide loader on failure
      console.error("Connection process failed:", error);
      $scope.isLoading = false;
      $scope.$apply();
    }
  };

  $scope.startStream = (type) => {
    // NEW LOG
    console.log(`UI startStream button clicked for type: ${type}`);
    dIdStreamService.startStream(type);
  };

  $scope.destroy = () => {
    // NEW LOG
    console.log("UI destroy button clicked.");
    dIdStreamService.destroy();
    $scope.idleVideoUrl = "";
    // NEW: Ensure loader is hidden on destroy
    $scope.isLoading = false;
  };
});
