/*
 * A tiny AAC-LC encoder for the browser: FFmpeg's native `aac` encoder (libavcodec, LGPL-2.1-or-later)
 * behind six exported functions, compiled to WebAssembly by scripts/aac-wasm/build.sh. Used by the
 * video editor only when the browser's WebCodecs has no AAC AudioEncoder (src/video-editor/engine/aac-fallback.ts).
 *
 * Input is planar float PCM written straight into the encoder's own frame buffers (aac_input);
 * output is raw AAC access units (no ADTS), with their presentation times in samples, collected
 * into one buffer that JavaScript reads and then clears.
 *
 * This file is part of the LGPL-licensed encoder module and is distributed under the same terms
 * (GNU Lesser General Public License, version 2.1 or later).
 */
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <libavcodec/avcodec.h>
#include <libavutil/channel_layout.h>
#include <libavutil/frame.h>
#include <libavutil/log.h>

#define EXPORT(name) __attribute__((export_name(#name)))
#define MAX_PACKETS 64

/* libavutil's random_seed.c links clock(), which WASI does not have; the encoder never needs it. */
#include <time.h>
clock_t clock(void) { return 0; }

static AVCodecContext *ctx;
static AVFrame *frame;
static AVPacket *pkt;

static uint8_t *out_data;
static int out_size, out_cap;
static int out_count;
static int32_t out_sizes[MAX_PACKETS];
static double out_pts[MAX_PACKETS];
static double out_dur[MAX_PACKETS];

EXPORT(aac_close) void aac_close(void) {
  avcodec_free_context(&ctx);
  av_frame_free(&frame);
  av_packet_free(&pkt);
  free(out_data);
  out_data = NULL;
  out_size = out_cap = out_count = 0;
}

/* 0 on success, a negative AVERROR otherwise. */
EXPORT(aac_open) int aac_open(int sample_rate, int channels, int bitrate) {
  const AVCodec *codec;
  int ret;
  av_log_set_level(AV_LOG_QUIET);
  aac_close();
  codec = avcodec_find_encoder(AV_CODEC_ID_AAC);
  if (!codec) return -1;
  ctx = avcodec_alloc_context3(codec);
  if (!ctx) return -2;
  ctx->sample_rate = sample_rate;
  ctx->sample_fmt = AV_SAMPLE_FMT_FLTP;
  ctx->bit_rate = bitrate;
  ctx->profile = AV_PROFILE_AAC_LOW;
  /* The MP4 needs the AudioSpecificConfig out of band (esds), not in-band ADTS. */
  ctx->flags |= AV_CODEC_FLAG_GLOBAL_HEADER;
  ctx->time_base = (AVRational){1, sample_rate};
  av_channel_layout_default(&ctx->ch_layout, channels);
  if ((ret = avcodec_open2(ctx, codec, NULL)) < 0) return ret;
  frame = av_frame_alloc();
  pkt = av_packet_alloc();
  if (!frame || !pkt) return -3;
  frame->format = AV_SAMPLE_FMT_FLTP;
  frame->nb_samples = ctx->frame_size;
  frame->sample_rate = sample_rate;
  if ((ret = av_channel_layout_copy(&frame->ch_layout, &ctx->ch_layout)) < 0) return ret;
  if ((ret = av_frame_get_buffer(frame, 0)) < 0) return ret;
  return 0;
}

EXPORT(aac_frame_size) int aac_frame_size(void) { return ctx ? ctx->frame_size : 0; }
EXPORT(aac_initial_padding) int aac_initial_padding(void) { return ctx ? ctx->initial_padding : 0; }
EXPORT(aac_extradata) uint8_t *aac_extradata(void) { return ctx ? ctx->extradata : NULL; }
EXPORT(aac_extradata_size) int aac_extradata_size(void) { return ctx ? ctx->extradata_size : 0; }

/* Where JavaScript writes channel `ch` of the next frame (frame_size floats). */
EXPORT(aac_input) float *aac_input(int ch) {
  if (!frame || av_frame_make_writable(frame) < 0) return NULL;
  return (float *)frame->extended_data[ch];
}

static int drain(void) {
  int ret;
  for (;;) {
    ret = avcodec_receive_packet(ctx, pkt);
    if (ret == AVERROR(EAGAIN) || ret == AVERROR_EOF) return 0;
    if (ret < 0) return ret;
    if (out_count >= MAX_PACKETS) {
      av_packet_unref(pkt);
      return -4;
    }
    if (out_size + pkt->size > out_cap) {
      int cap = (out_size + pkt->size) * 2 + 4096;
      uint8_t *grown = realloc(out_data, cap);
      if (!grown) {
        av_packet_unref(pkt);
        return -5;
      }
      out_data = grown;
      out_cap = cap;
    }
    memcpy(out_data + out_size, pkt->data, pkt->size);
    out_sizes[out_count] = pkt->size;
    out_pts[out_count] = (double)pkt->pts;
    out_dur[out_count] = (double)pkt->duration;
    out_count++;
    out_size += pkt->size;
    av_packet_unref(pkt);
  }
}

/*
 * Encodes the frame written through aac_input with `nb_samples` samples (frame_size, or fewer for the
 * last one) at `pts` (in samples); nb_samples 0 flushes the encoder. Returns the number of access
 * units now waiting (read them with aac_out_*, then aac_out_clear), or a negative error.
 */
EXPORT(aac_encode) int aac_encode(int nb_samples, double pts) {
  int ret;
  if (!ctx) return -1;
  if (nb_samples > 0) {
    frame->nb_samples = nb_samples;
    frame->pts = (int64_t)pts;
    ret = avcodec_send_frame(ctx, frame);
  } else {
    ret = avcodec_send_frame(ctx, NULL);
  }
  if (ret < 0 && ret != AVERROR_EOF) return ret;
  ret = drain();
  return ret < 0 ? ret : out_count;
}

EXPORT(aac_out_data) uint8_t *aac_out_data(void) { return out_data; }
EXPORT(aac_out_sizes) int32_t *aac_out_sizes(void) { return out_sizes; }
EXPORT(aac_out_pts) double *aac_out_pts(void) { return out_pts; }
EXPORT(aac_out_durations) double *aac_out_durations(void) { return out_dur; }
EXPORT(aac_out_clear) void aac_out_clear(void) { out_size = out_count = 0; }
