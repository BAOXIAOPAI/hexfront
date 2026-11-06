"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// ../../node_modules/.pnpm/ws@8.22.1/node_modules/ws/lib/constants.js
var require_constants = __commonJS({
  "../../node_modules/.pnpm/ws@8.22.1/node_modules/ws/lib/constants.js"(exports2, module2) {
    "use strict";
    var BINARY_TYPES = ["nodebuffer", "arraybuffer", "fragments"];
    var hasBlob = typeof Blob !== "undefined";
    if (hasBlob) BINARY_TYPES.push("blob");
    module2.exports = {
      BINARY_TYPES,
      CLOSE_TIMEOUT: 3e4,
      EMPTY_BUFFER: Buffer.alloc(0),
      GUID: "258EAFA5-E914-47DA-95CA-C5AB0DC85B11",
      hasBlob,
      kForOnEventAttribute: Symbol("kIsForOnEventAttribute"),
      kListener: Symbol("kListener"),
      kStatusCode: Symbol("status-code"),
      kWebSocket: Symbol("websocket"),
      NOOP: () => {
      }
    };
  }
});

// ../../node_modules/.pnpm/ws@8.22.1/node_modules/ws/lib/buffer-util.js
var require_buffer_util = __commonJS({
  "../../node_modules/.pnpm/ws@8.22.1/node_modules/ws/lib/buffer-util.js"(exports2, module2) {
    "use strict";
    var { websocketMask, websocketUnmask } = require("http");
    var { EMPTY_BUFFER } = require_constants();
    var FastBuffer = Buffer[Symbol.species];
    function concat(list, totalLength) {
      if (list.length === 0) return EMPTY_BUFFER;
      if (list.length === 1) return list[0];
      const target = Buffer.allocUnsafe(totalLength);
      let offset = 0;
      for (let i = 0; i < list.length; i++) {
        const buf = list[i];
        target.set(buf, offset);
        offset += buf.length;
      }
      if (offset < totalLength) {
        return new FastBuffer(target.buffer, target.byteOffset, offset);
      }
      return target;
    }
    function _mask(source, mask, output, offset, length) {
      for (let i = 0; i < length; i++) {
        output[offset + i] = source[i] ^ mask[i & 3];
      }
    }
    function _unmask(buffer, mask) {
      for (let i = 0; i < buffer.length; i++) {
        buffer[i] ^= mask[i & 3];
      }
    }
    function toArrayBuffer(buf) {
      if (buf.length === buf.buffer.byteLength) {
        return buf.buffer;
      }
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length);
    }
    function toBuffer(data) {
      toBuffer.readOnly = true;
      if (Buffer.isBuffer(data)) return data;
      let buf;
      if (data instanceof ArrayBuffer) {
        buf = new FastBuffer(data);
      } else if (ArrayBuffer.isView(data)) {
        buf = new FastBuffer(data.buffer, data.byteOffset, data.byteLength);
      } else {
        buf = Buffer.from(data);
        toBuffer.readOnly = false;
      }
      return buf;
    }
    module2.exports = {
      concat,
      mask: _mask,
      toArrayBuffer,
      toBuffer,
      unmask: _unmask
    };
    if (websocketMask) {
      module2.exports.mask = function(source, mask, output, offset, length) {
        if (length < 24) _mask(source, mask, output, offset, length);
        else websocketMask(source, mask, output, offset, length);
      };
      module2.exports.unmask = function(buffer, mask) {
        if (buffer.length < 24) _unmask(buffer, mask);
        else websocketUnmask(buffer, mask);
      };
    } else if (!process.env.WS_NO_BUFFER_UTIL) {
      try {
        const bufferUtil = require("bufferutil");
        module2.exports.mask = function(source, mask, output, offset, length) {
          if (length < 48) _mask(source, mask, output, offset, length);
          else bufferUtil.mask(source, mask, output, offset, length);
        };
        module2.exports.unmask = function(buffer, mask) {
          if (buffer.length < 32) _unmask(buffer, mask);
          else bufferUtil.unmask(buffer, mask);
        };
      } catch (e) {
      }
    }
  }
});

// ../../node_modules/.pnpm/ws@8.22.1/node_modules/ws/lib/limiter.js
var require_limiter = __commonJS({
  "../../node_modules/.pnpm/ws@8.22.1/node_modules/ws/lib/limiter.js"(exports2, module2) {
    "use strict";
    var kDone = Symbol("kDone");
    var kRun = Symbol("kRun");
    var Limiter = class {
      /**
       * Creates a new `Limiter`.
       *
       * @param {Number} [concurrency=Infinity] The maximum number of jobs allowed
       *     to run concurrently
       */
      constructor(concurrency) {
        this[kDone] = () => {
          this.pending--;
          this[kRun]();
        };
        this.concurrency = concurrency || Infinity;
        this.jobs = [];
        this.pending = 0;
      }
      /**
       * Adds a job to the queue.
       *
       * @param {Function} job The job to run
       * @public
       */
      add(job) {
        this.jobs.push(job);
        this[kRun]();
      }
      /**
       * Removes a job from the queue and runs it if possible.
       *
       * @private
       */
      [kRun]() {
        if (this.pending === this.concurrency) return;
        if (this.jobs.length) {
          const job = this.jobs.shift();
          this.pending++;
          job(this[kDone]);
        }
      }
    };
    module2.exports = Limiter;
  }
});

// ../../node_modules/.pnpm/ws@8.22.1/node_modules/ws/lib/permessage-deflate.js
var require_permessage_deflate = __commonJS({
  "../../node_modules/.pnpm/ws@8.22.1/node_modules/ws/lib/permessage-deflate.js"(exports2, module2) {
    "use strict";
    var zlib = require("zlib");
    var bufferUtil = require_buffer_util();
    var Limiter = require_limiter();
    var { kStatusCode } = require_constants();
    var FastBuffer = Buffer[Symbol.species];
    var TRAILER = Buffer.from([0, 0, 255, 255]);
    var kPerMessageDeflate = Symbol("permessage-deflate");
    var kTotalLength = Symbol("total-length");
    var kCallback = Symbol("callback");
    var kBuffers = Symbol("buffers");
    var kError = Symbol("error");
    var zlibLimiter;
    var PerMessageDeflate2 = class {
      /**
       * Creates a PerMessageDeflate instance.
       *
       * @param {Object} [options] Configuration options
       * @param {(Boolean|Number)} [options.clientMaxWindowBits] Advertise support
       *     for, or request, a custom client window size
       * @param {Boolean} [options.clientNoContextTakeover=false] Advertise/
       *     acknowledge disabling of client context takeover
       * @param {Number} [options.concurrencyLimit=10] The number of concurrent
       *     calls to zlib
       * @param {Boolean} [options.isServer=false] Create the instance in either
       *     server or client mode
       * @param {Number} [options.maxPayload=0] The maximum allowed message length
       * @param {(Boolean|Number)} [options.serverMaxWindowBits] Request/confirm the
       *     use of a custom server window size
       * @param {Boolean} [options.serverNoContextTakeover=false] Request/accept
       *     disabling of server context takeover
       * @param {Number} [options.threshold=1024] Size (in bytes) below which
       *     messages should not be compressed if context takeover is disabled
       * @param {Object} [options.zlibDeflateOptions] Options to pass to zlib on
       *     deflate
       * @param {Object} [options.zlibInflateOptions] Options to pass to zlib on
       *     inflate
       */
      constructor(options) {
        this._options = options || {};
        this._threshold = this._options.threshold !== void 0 ? this._options.threshold : 1024;
        this._maxPayload = this._options.maxPayload | 0;
        this._isServer = !!this._options.isServer;
        this._deflate = null;
        this._inflate = null;
        this.params = null;
        if (!zlibLimiter) {
          const concurrency = this._options.concurrencyLimit !== void 0 ? this._options.concurrencyLimit : 10;
          zlibLimiter = new Limiter(concurrency);
        }
      }
      /**
       * @type {String}
       */
      static get extensionName() {
        return "permessage-deflate";
      }
      /**
       * Create an extension negotiation offer.
       *
       * @return {Object} Extension parameters
       * @public
       */
      offer() {
        const params = {};
        if (this._options.serverNoContextTakeover) {
          params.server_no_context_takeover = true;
        }
        if (this._options.clientNoContextTakeover) {
          params.client_no_context_takeover = true;
        }
        if (this._options.serverMaxWindowBits) {
          params.server_max_window_bits = this._options.serverMaxWindowBits;
        }
        if (this._options.clientMaxWindowBits) {
          params.client_max_window_bits = this._options.clientMaxWindowBits;
        } else if (this._options.clientMaxWindowBits == null) {
          params.client_max_window_bits = true;
        }
        return params;
      }
      /**
       * Accept an extension negotiation offer/response.
       *
       * @param {Array} configurations The extension negotiation offers/reponse
       * @return {Object} Accepted configuration
       * @public
       */
      accept(configurations) {
        configurations = this.normalizeParams(configurations);
        this.params = this._isServer ? this.acceptAsServer(configurations) : this.acceptAsClient(configurations);
        return this.params;
      }
      /**
       * Releases all resources used by the extension.
       *
       * @public
       */
      cleanup() {
        if (this._inflate) {
          this._inflate.close();
          this._inflate = null;
        }
        if (this._deflate) {
          const callback = this._deflate[kCallback];
          this._deflate.close();
          this._deflate = null;
          if (callback) {
            callback(
              new Error(
                "The deflate stream was closed while data was being processed"
              )
            );
          }
        }
      }
      /**
       *  Accept an extension negotiation offer.
       *
       * @param {Array} offers The extension negotiation offers
       * @return {Object} Accepted configuration
       * @private
       */
      acceptAsServer(offers) {
        const opts = this._options;
        const accepted = offers.find((params) => {
          if (opts.serverNoContextTakeover === false && params.server_no_context_takeover || params.server_max_window_bits && (opts.serverMaxWindowBits === false || typeof opts.serverMaxWindowBits === "number" && opts.serverMaxWindowBits > params.server_max_window_bits) || typeof opts.clientMaxWindowBits === "number" && (typeof params.client_max_window_bits === "number" ? opts.clientMaxWindowBits > params.client_max_window_bits : !params.client_max_window_bits)) {
            return false;
          }
          return true;
        });
        if (!accepted) {
          throw new Error("None of the extension offers can be accepted");
        }
        if (opts.serverNoContextTakeover) {
          accepted.server_no_context_takeover = true;
        }
        if (opts.clientNoContextTakeover) {
          accepted.client_no_context_takeover = true;
        }
        if (typeof opts.serverMaxWindowBits === "number") {
          accepted.server_max_window_bits = opts.serverMaxWindowBits;
        }
        if (typeof opts.clientMaxWindowBits === "number") {
          accepted.client_max_window_bits = opts.clientMaxWindowBits;
        } else if (accepted.client_max_window_bits === true || opts.clientMaxWindowBits === false) {
          delete accepted.client_max_window_bits;
        }
        return accepted;
      }
      /**
       * Accept the extension negotiation response.
       *
       * @param {Array} response The extension negotiation response
       * @return {Object} Accepted configuration
       * @private
       */
      acceptAsClient(response) {
        const params = response[0];
        if (this._options.clientNoContextTakeover === false && params.client_no_context_takeover) {
          throw new Error('Unexpected parameter "client_no_context_takeover"');
        }
        if (!params.client_max_window_bits) {
          if (typeof this._options.clientMaxWindowBits === "number") {
            params.client_max_window_bits = this._options.clientMaxWindowBits;
          }
        } else if (this._options.clientMaxWindowBits === false || typeof this._options.clientMaxWindowBits === "number" && params.client_max_window_bits > this._options.clientMaxWindowBits) {
          throw new Error(
            'Unexpected or invalid parameter "client_max_window_bits"'
          );
        }
        return params;
      }
      /**
       * Normalize parameters.
       *
       * @param {Array} configurations The extension negotiation offers/reponse
       * @return {Array} The offers/response with normalized parameters
       * @private
       */
      normalizeParams(configurations) {
        configurations.forEach((params) => {
          Object.keys(params).forEach((key) => {
            let value = params[key];
            if (value.length > 1) {
              throw new Error(`Parameter "${key}" must have only a single value`);
            }
            value = value[0];
            if (key === "client_max_window_bits") {
              if (value !== true) {
                const num = +value;
                if (!Number.isInteger(num) || num < 8 || num > 15) {
                  throw new TypeError(
                    `Invalid value for parameter "${key}": ${value}`
                  );
                }
                value = num;
              } else if (!this._isServer) {
                throw new TypeError(
                  `Invalid value for parameter "${key}": ${value}`
                );
              }
            } else if (key === "server_max_window_bits") {
              const num = +value;
              if (!Number.isInteger(num) || num < 8 || num > 15) {
                throw new TypeError(
                  `Invalid value for parameter "${key}": ${value}`
                );
              }
              value = num;
            } else if (key === "client_no_context_takeover" || key === "server_no_context_takeover") {
              if (value !== true) {
                throw new TypeError(
                  `Invalid value for parameter "${key}": ${value}`
                );
              }
            } else {
              throw new Error(`Unknown parameter "${key}"`);
            }
            params[key] = value;
          });
        });
        return configurations;
      }
      /**
       * Decompress data. Concurrency limited.
       *
       * @param {Buffer} data Compressed data
       * @param {Boolean} fin Specifies whether or not this is the last fragment
       * @param {Function} callback Callback
       * @public
       */
      decompress(data, fin, callback) {
        zlibLimiter.add((done) => {
          this._decompress(data, fin, (err, result) => {
            done();
            callback(err, result);
          });
        });
      }
      /**
       * Compress data. Concurrency limited.
       *
       * @param {(Buffer|String)} data Data to compress
       * @param {Boolean} fin Specifies whether or not this is the last fragment
       * @param {Function} callback Callback
       * @public
       */
      compress(data, fin, callback) {
        zlibLimiter.add((done) => {
          this._compress(data, fin, (err, result) => {
            done();
            callback(err, result);
          });
        });
      }
      /**
       * Decompress data.
       *
       * @param {Buffer} data Compressed data
       * @param {Boolean} fin Specifies whether or not this is the last fragment
       * @param {Function} callback Callback
       * @private
       */
      _decompress(data, fin, callback) {
        const endpoint = this._isServer ? "client" : "server";
        if (!this._inflate) {
          const key = `${endpoint}_max_window_bits`;
          const windowBits = typeof this.params[key] !== "number" ? zlib.Z_DEFAULT_WINDOWBITS : this.params[key];
          this._inflate = zlib.createInflateRaw({
            ...this._options.zlibInflateOptions,
            windowBits
          });
          this._inflate[kPerMessageDeflate] = this;
          this._inflate[kTotalLength] = 0;
          this._inflate[kBuffers] = [];
          this._inflate.on("error", inflateOnError);
          this._inflate.on("data", inflateOnData);
        }
        this._inflate[kCallback] = callback;
        this._inflate.write(data);
        if (fin) this._inflate.write(TRAILER);
        this._inflate.flush(() => {
          const err = this._inflate[kError];
          if (err) {
            this._inflate.close();
            this._inflate = null;
            callback(err);
            return;
          }
          const data2 = bufferUtil.concat(
            this._inflate[kBuffers],
            this._inflate[kTotalLength]
          );
          if (this._inflate._readableState.endEmitted) {
            this._inflate.close();
            this._inflate = null;
          } else {
            this._inflate[kTotalLength] = 0;
            this._inflate[kBuffers] = [];
            if (fin && this.params[`${endpoint}_no_context_takeover`]) {
              this._inflate.reset();
            }
          }
          callback(null, data2);
        });
      }
      /**
       * Compress data.
       *
       * @param {(Buffer|String)} data Data to compress
       * @param {Boolean} fin Specifies whether or not this is the last fragment
       * @param {Function} callback Callback
       * @private
       */
      _compress(data, fin, callback) {
        const endpoint = this._isServer ? "server" : "client";
        if (!this._deflate) {
          const key = `${endpoint}_max_window_bits`;
          const windowBits = typeof this.params[key] !== "number" ? zlib.Z_DEFAULT_WINDOWBITS : this.params[key];
          this._deflate = zlib.createDeflateRaw({
            ...this._options.zlibDeflateOptions,
            windowBits
          });
          this._deflate[kTotalLength] = 0;
          this._deflate[kBuffers] = [];
          this._deflate.on("data", deflateOnData);
        }
        this._deflate[kCallback] = callback;
        this._deflate.write(data);
        this._deflate.flush(zlib.Z_SYNC_FLUSH, () => {
          if (!this._deflate) {
            return;
          }
          let data2 = bufferUtil.concat(
            this._deflate[kBuffers],
            this._deflate[kTotalLength]
          );
          if (fin) {
            data2 = new FastBuffer(data2.buffer, data2.byteOffset, data2.length - 4);
          }
          this._deflate[kCallback] = null;
          this._deflate[kTotalLength] = 0;
          this._deflate[kBuffers] = [];
          if (fin && this.params[`${endpoint}_no_context_takeover`]) {
            this._deflate.reset();
          }
          callback(null, data2);
        });
      }
    };
    module2.exports = PerMessageDeflate2;
    function deflateOnData(chunk) {
      this[kBuffers].push(chunk);
      this[kTotalLength] += chunk.length;
    }
    function inflateOnData(chunk) {
      this[kTotalLength] += chunk.length;
      if (this[kPerMessageDeflate]._maxPayload < 1 || this[kTotalLength] <= this[kPerMessageDeflate]._maxPayload) {
        this[kBuffers].push(chunk);
        return;
      }
      this[kError] = new RangeError("Max payload size exceeded");
      this[kError].code = "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH";
      this[kError][kStatusCode] = 1009;
      this.removeListener("data", inflateOnData);
      this.reset();
    }
    function inflateOnError(err) {
      this[kPerMessageDeflate]._inflate = null;
      if (this[kError]) {
        this[kCallback](this[kError]);
        return;
      }
      err[kStatusCode] = 1007;
      this[kCallback](err);
    }
  }
});

// ../../node_modules/.pnpm/ws@8.22.1/node_modules/ws/lib/validation.js
var require_validation = __commonJS({
  "../../node_modules/.pnpm/ws@8.22.1/node_modules/ws/lib/validation.js"(exports2, module2) {
    "use strict";
    var { isUtf8 } = require("buffer");
    var { hasBlob } = require_constants();
    var tokenChars = [
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      // 0 - 15
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      // 16 - 31
      0,
      1,
      0,
      1,
      1,
      1,
      1,
      1,
      0,
      0,
      1,
      1,
      0,
      1,
      1,
      0,
      // 32 - 47
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      0,
      0,
      0,
      0,
      0,
      0,
      // 48 - 63
      0,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      // 64 - 79
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      0,
      0,
      0,
      1,
      1,
      // 80 - 95
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      // 96 - 111
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      0,
      1,
      0,
      1,
      0
      // 112 - 127
    ];
    function isValidStatusCode(code) {
      return code >= 1e3 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006 || code >= 3e3 && code <= 4999;
    }
    function _isValidUTF8(buf) {
      const len = buf.length;
      let i = 0;
      while (i < len) {
        if ((buf[i] & 128) === 0) {
          i++;
        } else if ((buf[i] & 224) === 192) {
          if (i + 1 === len || (buf[i + 1] & 192) !== 128 || (buf[i] & 254) === 192) {
            return false;
          }
          i += 2;
        } else if ((buf[i] & 240) === 224) {
          if (i + 2 >= len || (buf[i + 1] & 192) !== 128 || (buf[i + 2] & 192) !== 128 || buf[i] === 224 && (buf[i + 1] & 224) === 128 || // Overlong
          buf[i] === 237 && (buf[i + 1] & 224) === 160) {
            return false;
          }
          i += 3;
        } else if ((buf[i] & 248) === 240) {
          if (i + 3 >= len || (buf[i + 1] & 192) !== 128 || (buf[i + 2] & 192) !== 128 || (buf[i + 3] & 192) !== 128 || buf[i] === 240 && (buf[i + 1] & 240) === 128 || // Overlong
          buf[i] === 244 && buf[i + 1] > 143 || buf[i] > 244) {
            return false;
          }
          i += 4;
        } else {
          return false;
        }
      }
      return true;
    }
    function isBlob(value) {
      return hasBlob && typeof value === "object" && typeof value.arrayBuffer === "function" && typeof value.type === "string" && typeof value.stream === "function" && (value[Symbol.toStringTag] === "Blob" || value[Symbol.toStringTag] === "File");
    }
    module2.exports = {
      isBlob,
      isValidStatusCode,
      isValidUTF8: _isValidUTF8,
      tokenChars
    };
    if (isUtf8) {
      module2.exports.isValidUTF8 = function(buf) {
        return buf.length < 24 ? _isValidUTF8(buf) : isUtf8(buf);
      };
    } else if (!process.env.WS_NO_UTF_8_VALIDATE) {
      try {
        const isValidUTF8 = require("utf-8-validate");
        module2.exports.isValidUTF8 = function(buf) {
          return buf.length < 32 ? _isValidUTF8(buf) : isValidUTF8(buf);
        };
      } catch (e) {
      }
    }
  }
});

// ../../node_modules/.pnpm/ws@8.22.1/node_modules/ws/lib/receiver.js
var require_receiver = __commonJS({
  "../../node_modules/.pnpm/ws@8.22.1/node_modules/ws/lib/receiver.js"(exports2, module2) {
    "use strict";
    var { Writable } = require("stream");
    var PerMessageDeflate2 = require_permessage_deflate();
    var {
      BINARY_TYPES,
      EMPTY_BUFFER,
      kStatusCode,
      kWebSocket
    } = require_constants();
    var { concat, toArrayBuffer, unmask } = require_buffer_util();
    var { isValidStatusCode, isValidUTF8 } = require_validation();
    var FastBuffer = Buffer[Symbol.species];
    var GET_INFO = 0;
    var GET_PAYLOAD_LENGTH_16 = 1;
    var GET_PAYLOAD_LENGTH_64 = 2;
    var GET_MASK = 3;
    var GET_DATA = 4;
    var INFLATING = 5;
    var DEFER_EVENT = 6;
    var Receiver2 = class extends Writable {
      /**
       * Creates a Receiver instance.
       *
       * @param {Object} [options] Options object
       * @param {Boolean} [options.allowSynchronousEvents=true] Specifies whether
       *     any of the `'message'`, `'ping'`, and `'pong'` events can be emitted
       *     multiple times in the same tick
       * @param {String} [options.binaryType=nodebuffer] The type for binary data
       * @param {Object} [options.extensions] An object containing the negotiated
       *     extensions
       * @param {Boolean} [options.isServer=false] Specifies whether to operate in
       *     client or server mode
       * @param {Number} [options.maxBufferedChunks=0] The maximum number of
       *     buffered data chunks
       * @param {Number} [options.maxFragments=0] The maximum number of message
       *     fragments
       * @param {Number} [options.maxPayload=0] The maximum allowed message length
       * @param {Boolean} [options.skipUTF8Validation=false] Specifies whether or
       *     not to skip UTF-8 validation for text and close messages
       */
      constructor(options = {}) {
        super();
        this._allowSynchronousEvents = options.allowSynchronousEvents !== void 0 ? options.allowSynchronousEvents : true;
        this._binaryType = options.binaryType || BINARY_TYPES[0];
        this._extensions = options.extensions || {};
        this._isServer = !!options.isServer;
        this._maxBufferedChunks = options.maxBufferedChunks | 0;
        this._maxFragments = options.maxFragments | 0;
        this._maxPayload = options.maxPayload | 0;
        this._skipUTF8Validation = !!options.skipUTF8Validation;
        this[kWebSocket] = void 0;
        this._bufferedBytes = 0;
        this._buffers = [];
        this._compressed = false;
        this._payloadLength = 0;
        this._mask = void 0;
        this._fragmented = 0;
        this._masked = false;
        this._fin = false;
        this._opcode = 0;
        this._totalPayloadLength = 0;
        this._messageLength = 0;
        this._numFragments = 0;
        this._fragments = [];
        this._errored = false;
        this._loop = false;
        this._state = GET_INFO;
      }
      /**
       * Implements `Writable.prototype._write()`.
       *
       * @param {Buffer} chunk The chunk of data to write
       * @param {String} encoding The character encoding of `chunk`
       * @param {Function} cb Callback
       * @private
       */
      _write(chunk, encoding, cb) {
        if (this._opcode === 8 && this._state == GET_INFO) return cb();
        if (this._maxBufferedChunks > 0 && this._buffers.length >= this._maxBufferedChunks) {
          cb(
            this.createError(
              RangeError,
              "Too many buffered chunks",
              false,
              1008,
              "WS_ERR_TOO_MANY_BUFFERED_PARTS"
            )
          );
          return;
        }
        this._bufferedBytes += chunk.length;
        this._buffers.push(chunk);
        this.startLoop(cb);
      }
      /**
       * Consumes `n` bytes from the buffered data.
       *
       * @param {Number} n The number of bytes to consume
       * @return {Buffer} The consumed bytes
       * @private
       */
      consume(n) {
        this._bufferedBytes -= n;
        if (n === this._buffers[0].length) return this._buffers.shift();
        if (n < this._buffers[0].length) {
          const buf = this._buffers[0];
          this._buffers[0] = new FastBuffer(
            buf.buffer,
            buf.byteOffset + n,
            buf.length - n
          );
          return new FastBuffer(buf.buffer, buf.byteOffset, n);
        }
        const dst = Buffer.allocUnsafe(n);
        do {
          const buf = this._buffers[0];
          const offset = dst.length - n;
          if (n >= buf.length) {
            dst.set(this._buffers.shift(), offset);
          } else {
            dst.set(new Uint8Array(buf.buffer, buf.byteOffset, n), offset);
            this._buffers[0] = new FastBuffer(
              buf.buffer,
              buf.byteOffset + n,
              buf.length - n
            );
          }
          n -= buf.length;
        } while (n > 0);
        return dst;
      }
      /**
       * Starts the parsing loop.
       *
       * @param {Function} cb Callback
       * @private
       */
      startLoop(cb) {
        this._loop = true;
        do {
          switch (this._state) {
            case GET_INFO:
              this.getInfo(cb);
              break;
            case GET_PAYLOAD_LENGTH_16:
              this.getPayloadLength16(cb);
              break;
            case GET_PAYLOAD_LENGTH_64:
              this.getPayloadLength64(cb);
              break;
            case GET_MASK:
              this.getMask();
              break;
            case GET_DATA:
              this.getData(cb);
              break;
            case INFLATING:
            case DEFER_EVENT:
              this._loop = false;
              return;
          }
        } while (this._loop);
        if (!this._errored) cb();
      }
      /**
       * Reads the first two bytes of a frame.
       *
       * @param {Function} cb Callback
       * @private
       */
      getInfo(cb) {
        if (this._bufferedBytes < 2) {
          this._loop = false;
          return;
        }
        const buf = this.consume(2);
        if ((buf[0] & 48) !== 0) {
          const error = this.createError(
            RangeError,
            "RSV2 and RSV3 must be clear",
            true,
            1002,
            "WS_ERR_UNEXPECTED_RSV_2_3"
          );
          cb(error);
          return;
        }
        const compressed = (buf[0] & 64) === 64;
        if (compressed && !this._extensions[PerMessageDeflate2.extensionName]) {
          const error = this.createError(
            RangeError,
            "RSV1 must be clear",
            true,
            1002,
            "WS_ERR_UNEXPECTED_RSV_1"
          );
          cb(error);
          return;
        }
        this._fin = (buf[0] & 128) === 128;
        this._opcode = buf[0] & 15;
        this._payloadLength = buf[1] & 127;
        if (this._opcode === 0) {
          if (compressed) {
            const error = this.createError(
              RangeError,
              "RSV1 must be clear",
              true,
              1002,
              "WS_ERR_UNEXPECTED_RSV_1"
            );
            cb(error);
            return;
          }
          if (!this._fragmented) {
            const error = this.createError(
              RangeError,
              "invalid opcode 0",
              true,
              1002,
              "WS_ERR_INVALID_OPCODE"
            );
            cb(error);
            return;
          }
          this._opcode = this._fragmented;
        } else if (this._opcode === 1 || this._opcode === 2) {
          if (this._fragmented) {
            const error = this.createError(
              RangeError,
              `invalid opcode ${this._opcode}`,
              true,
              1002,
              "WS_ERR_INVALID_OPCODE"
            );
            cb(error);
            return;
          }
          this._compressed = compressed;
        } else if (this._opcode > 7 && this._opcode < 11) {
          if (!this._fin) {
            const error = this.createError(
              RangeError,
              "FIN must be set",
              true,
              1002,
              "WS_ERR_EXPECTED_FIN"
            );
            cb(error);
            return;
          }
          if (compressed) {
            const error = this.createError(
              RangeError,
              "RSV1 must be clear",
              true,
              1002,
              "WS_ERR_UNEXPECTED_RSV_1"
            );
            cb(error);
            return;
          }
          if (this._payloadLength > 125 || this._opcode === 8 && this._payloadLength === 1) {
            const error = this.createError(
              RangeError,
              `invalid payload length ${this._payloadLength}`,
              true,
              1002,
              "WS_ERR_INVALID_CONTROL_PAYLOAD_LENGTH"
            );
            cb(error);
            return;
          }
        } else {
          const error = this.createError(
            RangeError,
            `invalid opcode ${this._opcode}`,
            true,
            1002,
            "WS_ERR_INVALID_OPCODE"
          );
          cb(error);
          return;
        }
        if (!this._fin && !this._fragmented) this._fragmented = this._opcode;
        this._masked = (buf[1] & 128) === 128;
        if (this._isServer) {
          if (!this._masked) {
            const error = this.createError(
              RangeError,
              "MASK must be set",
              true,
              1002,
              "WS_ERR_EXPECTED_MASK"
            );
            cb(error);
            return;
          }
        } else if (this._masked) {
          const error = this.createError(
            RangeError,
            "MASK must be clear",
            true,
            1002,
            "WS_ERR_UNEXPECTED_MASK"
          );
          cb(error);
          return;
        }
        if (this._payloadLength === 126) this._state = GET_PAYLOAD_LENGTH_16;
        else if (this._payloadLength === 127) this._state = GET_PAYLOAD_LENGTH_64;
        else this.haveLength(cb);
      }
      /**
       * Gets extended payload length (7+16).
       *
       * @param {Function} cb Callback
       * @private
       */
      getPayloadLength16(cb) {
        if (this._bufferedBytes < 2) {
          this._loop = false;
          return;
        }
        this._payloadLength = this.consume(2).readUInt16BE(0);
        this.haveLength(cb);
      }
      /**
       * Gets extended payload length (7+64).
       *
       * @param {Function} cb Callback
       * @private
       */
      getPayloadLength64(cb) {
        if (this._bufferedBytes < 8) {
          this._loop = false;
          return;
        }
        const buf = this.consume(8);
        const num = buf.readUInt32BE(0);
        if (num > Math.pow(2, 53 - 32) - 1) {
          const error = this.createError(
            RangeError,
            "Unsupported WebSocket frame: payload length > 2^53 - 1",
            false,
            1009,
            "WS_ERR_UNSUPPORTED_DATA_PAYLOAD_LENGTH"
          );
          cb(error);
          return;
        }
        this._payloadLength = num * Math.pow(2, 32) + buf.readUInt32BE(4);
        this.haveLength(cb);
      }
      /**
       * Payload length has been read.
       *
       * @param {Function} cb Callback
       * @private
       */
      haveLength(cb) {
        if (this._payloadLength && this._opcode < 8) {
          this._totalPayloadLength += this._payloadLength;
          if (this._totalPayloadLength > this._maxPayload && this._maxPayload > 0) {
            const error = this.createError(
              RangeError,
              "Max payload size exceeded",
              false,
              1009,
              "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH"
            );
            cb(error);
            return;
          }
        }
        if (this._masked) this._state = GET_MASK;
        else this._state = GET_DATA;
      }
      /**
       * Reads mask bytes.
       *
       * @private
       */
      getMask() {
        if (this._bufferedBytes < 4) {
          this._loop = false;
          return;
        }
        this._mask = this.consume(4);
        this._state = GET_DATA;
      }
      /**
       * Reads data bytes.
       *
       * @param {Function} cb Callback
       * @private
       */
      getData(cb) {
        let data = EMPTY_BUFFER;
        if (this._payloadLength) {
          if (this._bufferedBytes < this._payloadLength) {
            this._loop = false;
            return;
          }
          data = this.consume(this._payloadLength);
          if (this._masked && (this._mask[0] | this._mask[1] | this._mask[2] | this._mask[3]) !== 0) {
            unmask(data, this._mask);
          }
        }
        if (this._opcode > 7) {
          this.controlMessage(data, cb);
          return;
        }
        if (this._maxFragments > 0 && ++this._numFragments > this._maxFragments) {
          const error = this.createError(
            RangeError,
            "Too many message fragments",
            false,
            1008,
            "WS_ERR_TOO_MANY_BUFFERED_PARTS"
          );
          cb(error);
          return;
        }
        if (this._compressed) {
          this._state = INFLATING;
          this.decompress(data, cb);
          return;
        }
        if (data.length) {
          this._messageLength = this._totalPayloadLength;
          this._fragments.push(data);
        }
        this.dataMessage(cb);
      }
      /**
       * Decompresses data.
       *
       * @param {Buffer} data Compressed data
       * @param {Function} cb Callback
       * @private
       */
      decompress(data, cb) {
        const perMessageDeflate = this._extensions[PerMessageDeflate2.extensionName];
        perMessageDeflate.decompress(data, this._fin, (err, buf) => {
          if (err) return cb(err);
          if (buf.length) {
            this._messageLength += buf.length;
            if (this._messageLength > this._maxPayload && this._maxPayload > 0) {
              const error = this.createError(
                RangeError,
                "Max payload size exceeded",
                false,
                1009,
                "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH"
              );
              cb(error);
              return;
            }
            this._fragments.push(buf);
          }
          this.dataMessage(cb);
          if (this._state === GET_INFO) this.startLoop(cb);
        });
      }
      /**
       * Handles a data message.
       *
       * @param {Function} cb Callback
       * @private
       */
      dataMessage(cb) {
        if (!this._fin) {
          this._state = GET_INFO;
          return;
        }
        const messageLength = this._messageLength;
        const fragments = this._fragments;
        this._totalPayloadLength = 0;
        this._messageLength = 0;
        this._fragmented = 0;
        this._numFragments = 0;
        this._fragments = [];
        if (this._opcode === 2) {
          let data;
          if (this._binaryType === "nodebuffer") {
            data = concat(fragments, messageLength);
          } else if (this._binaryType === "arraybuffer") {
            data = toArrayBuffer(concat(fragments, messageLength));
          } else if (this._binaryType === "blob") {
            data = new Blob(fragments);
          } else {
            data = fragments;
          }
          if (this._allowSynchronousEvents) {
            this.emit("message", data, true);
            this._state = GET_INFO;
          } else {
            this._state = DEFER_EVENT;
            setImmediate(() => {
              this.emit("message", data, true);
              this._state = GET_INFO;
              this.startLoop(cb);
            });
          }
        } else {
          const buf = concat(fragments, messageLength);
          if (!this._skipUTF8Validation && !isValidUTF8(buf)) {
            const error = this.createError(
              Error,
              "invalid UTF-8 sequence",
              true,
              1007,
              "WS_ERR_INVALID_UTF8"
            );
            cb(error);
            return;
          }
          if (this._state === INFLATING || this._allowSynchronousEvents) {
            this.emit("message", buf, false);
            this._state = GET_INFO;
          } else {
            this._state = DEFER_EVENT;
            setImmediate(() => {
              this.emit("message", buf, false);
              this._state = GET_INFO;
              this.startLoop(cb);
            });
          }
        }
      }
      /**
       * Handles a control message.
       *
       * @param {Buffer} data Data to handle
       * @return {(Error|RangeError|undefined)} A possible error
       * @private
       */
      controlMessage(data, cb) {
        if (this._opcode === 8) {
          if (data.length === 0) {
            this._loop = false;
            this.emit("conclude", 1005, EMPTY_BUFFER);
            this.end();
          } else {
            const code = data.readUInt16BE(0);
            if (!isValidStatusCode(code)) {
              const error = this.createError(
                RangeError,
                `invalid status code ${code}`,
                true,
                1002,
                "WS_ERR_INVALID_CLOSE_CODE"
              );
              cb(error);
              return;
            }
            const buf = new FastBuffer(
              data.buffer,
              data.byteOffset + 2,
              data.length - 2
            );
            if (!this._skipUTF8Validation && !isValidUTF8(buf)) {
              const error = this.createError(
                Error,
                "invalid UTF-8 sequence",
                true,
                1007,
                "WS_ERR_INVALID_UTF8"
              );
              cb(error);
              return;
            }
            this._loop = false;
            this.emit("conclude", code, buf);
            this.end();
          }
          this._state = GET_INFO;
          return;
        }
        if (this._allowSynchronousEvents) {
          this.emit(this._opcode === 9 ? "ping" : "pong", data);
          this._state = GET_INFO;
        } else {
          this._state = DEFER_EVENT;
          setImmediate(() => {
            this.emit(this._opcode === 9 ? "ping" : "pong", data);
            this._state = GET_INFO;
            this.startLoop(cb);
          });
        }
      }
      /**
       * Builds an error object.
       *
       * @param {function(new:Error|RangeError)} ErrorCtor The error constructor
       * @param {String} message The error message
       * @param {Boolean} prefix Specifies whether or not to add a default prefix to
       *     `message`
       * @param {Number} statusCode The status code
       * @param {String} errorCode The exposed error code
       * @return {(Error|RangeError)} The error
       * @private
       */
      createError(ErrorCtor, message, prefix, statusCode, errorCode) {
        this._loop = false;
        this._errored = true;
        const err = new ErrorCtor(
          prefix ? `Invalid WebSocket frame: ${message}` : message
        );
        Error.captureStackTrace(err, this.createError);
        err.code = errorCode;
        err[kStatusCode] = statusCode;
        return err;
      }
    };
    module2.exports = Receiver2;
  }
});

// ../../node_modules/.pnpm/ws@8.22.1/node_modules/ws/lib/sender.js
var require_sender = __commonJS({
  "../../node_modules/.pnpm/ws@8.22.1/node_modules/ws/lib/sender.js"(exports2, module2) {
    "use strict";
    var { Duplex } = require("stream");
    var { randomFillSync } = require("crypto");
    var {
      types: { isUint8Array }
    } = require("util");
    var PerMessageDeflate2 = require_permessage_deflate();
    var { EMPTY_BUFFER, kWebSocket, NOOP } = require_constants();
    var { isBlob, isValidStatusCode } = require_validation();
    var { mask: applyMask, toBuffer } = require_buffer_util();
    var kByteLength = Symbol("kByteLength");
    var maskBuffer = Buffer.alloc(4);
    var RANDOM_POOL_SIZE = 8 * 1024;
    var randomPool;
    var randomPoolPointer = RANDOM_POOL_SIZE;
    var DEFAULT = 0;
    var DEFLATING = 1;
    var GET_BLOB_DATA = 2;
    var Sender2 = class _Sender {
      /**
       * Creates a Sender instance.
       *
       * @param {Duplex} socket The connection socket
       * @param {Object} [extensions] An object containing the negotiated extensions
       * @param {Function} [generateMask] The function used to generate the masking
       *     key
       */
      constructor(socket, extensions, generateMask) {
        this._extensions = extensions || {};
        if (generateMask) {
          this._generateMask = generateMask;
          this._maskBuffer = Buffer.alloc(4);
        }
        this._socket = socket;
        this._firstFragment = true;
        this._compress = false;
        this._bufferedBytes = 0;
        this._queue = [];
        this._state = DEFAULT;
        this.onerror = NOOP;
        this[kWebSocket] = void 0;
      }
      /**
       * Frames a piece of data according to the HyBi WebSocket protocol.
       *
       * @param {(Buffer|String)} data The data to frame
       * @param {Object} options Options object
       * @param {Boolean} [options.fin=false] Specifies whether or not to set the
       *     FIN bit
       * @param {Function} [options.generateMask] The function used to generate the
       *     masking key
       * @param {Boolean} [options.mask=false] Specifies whether or not to mask
       *     `data`
       * @param {Buffer} [options.maskBuffer] The buffer used to store the masking
       *     key
       * @param {Number} options.opcode The opcode
       * @param {Boolean} [options.readOnly=false] Specifies whether `data` can be
       *     modified
       * @param {Boolean} [options.rsv1=false] Specifies whether or not to set the
       *     RSV1 bit
       * @return {(Buffer|String)[]} The framed data
       * @public
       */
      static frame(data, options) {
        let mask;
        let merge = false;
        let offset = 2;
        let skipMasking = false;
        if (options.mask) {
          mask = options.maskBuffer || maskBuffer;
          if (options.generateMask) {
            options.generateMask(mask);
          } else {
            if (randomPoolPointer === RANDOM_POOL_SIZE) {
              if (randomPool === void 0) {
                randomPool = Buffer.alloc(RANDOM_POOL_SIZE);
              }
              randomFillSync(randomPool, 0, RANDOM_POOL_SIZE);
              randomPoolPointer = 0;
            }
            mask[0] = randomPool[randomPoolPointer++];
            mask[1] = randomPool[randomPoolPointer++];
            mask[2] = randomPool[randomPoolPointer++];
            mask[3] = randomPool[randomPoolPointer++];
          }
          skipMasking = (mask[0] | mask[1] | mask[2] | mask[3]) === 0;
          offset = 6;
        }
        let dataLength;
        if (typeof data === "string") {
          if ((!options.mask || skipMasking) && options[kByteLength] !== void 0) {
            dataLength = options[kByteLength];
          } else {
            data = Buffer.from(data);
            dataLength = data.length;
          }
        } else {
          dataLength = data.length;
          merge = options.mask && options.readOnly && !skipMasking;
        }
        let payloadLength = dataLength;
        if (dataLength >= 65536) {
          offset += 8;
          payloadLength = 127;
        } else if (dataLength > 125) {
          offset += 2;
          payloadLength = 126;
        }
        const target = Buffer.allocUnsafe(merge ? dataLength + offset : offset);
        target[0] = options.fin ? options.opcode | 128 : options.opcode;
        if (options.rsv1) target[0] |= 64;
        target[1] = payloadLength;
        if (payloadLength === 126) {
          target.writeUInt16BE(dataLength, 2);
        } else if (payloadLength === 127) {
          target[2] = target[3] = 0;
          target.writeUIntBE(dataLength, 4, 6);
        }
        if (!options.mask) {
          return dataLength ? [target, data] : [target];
        }
        target[1] |= 128;
        target[offset - 4] = mask[0];
        target[offset - 3] = mask[1];
        target[offset - 2] = mask[2];
        target[offset - 1] = mask[3];
        if (!dataLength) return [target];
        if (skipMasking) return [target, data];
        if (merge) {
          applyMask(data, mask, target, offset, dataLength);
          return [target];
        }
        applyMask(data, mask, data, 0, dataLength);
        return [target, data];
      }
      /**
       * Sends a close message to the other peer.
       *
       * @param {Number} [code] The status code component of the body
       * @param {(String|Buffer)} [data] The message component of the body
       * @param {Boolean} [mask=false] Specifies whether or not to mask the message
       * @param {Function} [cb] Callback
       * @public
       */
      close(code, data, mask, cb) {
        let buf;
        if (code === void 0) {
          buf = EMPTY_BUFFER;
        } else if (typeof code !== "number" || !isValidStatusCode(code)) {
          throw new TypeError("First argument must be a valid error code number");
        } else if (data === void 0 || !data.length) {
          buf = Buffer.allocUnsafe(2);
          buf.writeUInt16BE(code, 0);
        } else {
          const length = Buffer.byteLength(data);
          if (length > 123) {
            throw new RangeError("The message must not be greater than 123 bytes");
          }
          buf = Buffer.allocUnsafe(2 + length);
          buf.writeUInt16BE(code, 0);
          if (typeof data === "string") {
            buf.write(data, 2);
          } else if (isUint8Array(data)) {
            buf.set(data, 2);
          } else {
            throw new TypeError("Second argument must be a string or a Uint8Array");
          }
        }
        const options = {
          [kByteLength]: buf.length,
          fin: true,
          generateMask: this._generateMask,
          mask,
          maskBuffer: this._maskBuffer,
          opcode: 8,
          readOnly: false,
          rsv1: false
        };
        if (this._state !== DEFAULT) {
          this.enqueue([this.dispatch, buf, false, options, cb]);
        } else {
          this.sendFrame(_Sender.frame(buf, options), cb);
        }
      }
      /**
       * Sends a ping message to the other peer.
       *
       * @param {*} data The message to send
       * @param {Boolean} [mask=false] Specifies whether or not to mask `data`
       * @param {Function} [cb] Callback
       * @public
       */
      ping(data, mask, cb) {
        let byteLength;
        let readOnly;
        if (typeof data === "string") {
          byteLength = Buffer.byteLength(data);
          readOnly = false;
        } else if (isBlob(data)) {
          byteLength = data.size;
          readOnly = false;
        } else {
          data = toBuffer(data);
          byteLength = data.length;
          readOnly = toBuffer.readOnly;
        }
        if (byteLength > 125) {
          throw new RangeError("The data size must not be greater than 125 bytes");
        }
        const options = {
          [kByteLength]: byteLength,
          fin: true,
          generateMask: this._generateMask,
          mask,
          maskBuffer: this._maskBuffer,
          opcode: 9,
          readOnly,
          rsv1: false
        };
        if (isBlob(data)) {
          if (this._state !== DEFAULT) {
            this.enqueue([this.getBlobData, data, false, options, cb]);
          } else {
            this.getBlobData(data, false, options, cb);
          }
        } else if (this._state !== DEFAULT) {
          this.enqueue([this.dispatch, data, false, options, cb]);
        } else {
          this.sendFrame(_Sender.frame(data, options), cb);
        }
      }
      /**
       * Sends a pong message to the other peer.
       *
       * @param {*} data The message to send
       * @param {Boolean} [mask=false] Specifies whether or not to mask `data`
       * @param {Function} [cb] Callback
       * @public
       */
      pong(data, mask, cb) {
        let byteLength;
        let readOnly;
        if (typeof data === "string") {
          byteLength = Buffer.byteLength(data);
          readOnly = false;
        } else if (isBlob(data)) {
          byteLength = data.size;
          readOnly = false;
        } else {
          data = toBuffer(data);
          byteLength = data.length;
          readOnly = toBuffer.readOnly;
        }
        if (byteLength > 125) {
          throw new RangeError("The data size must not be greater than 125 bytes");
        }
        const options = {
          [kByteLength]: byteLength,
          fin: true,
          generateMask: this._generateMask,
          mask,
          maskBuffer: this._maskBuffer,
          opcode: 10,
          readOnly,
          rsv1: false
        };
        if (isBlob(data)) {
          if (this._state !== DEFAULT) {
            this.enqueue([this.getBlobData, data, false, options, cb]);
          } else {
            this.getBlobData(data, false, options, cb);
          }
        } else if (this._state !== DEFAULT) {
          this.enqueue([this.dispatch, data, false, options, cb]);
        } else {
          this.sendFrame(_Sender.frame(data, options), cb);
        }
      }
      /**
       * Sends a data message to the other peer.
       *
       * @param {*} data The message to send
       * @param {Object} options Options object
       * @param {Boolean} [options.binary=false] Specifies whether `data` is binary
       *     or text
       * @param {Boolean} [options.compress=false] Specifies whether or not to
       *     compress `data`
       * @param {Boolean} [options.fin=false] Specifies whether the fragment is the
       *     last one
       * @param {Boolean} [options.mask=false] Specifies whether or not to mask
       *     `data`
       * @param {Function} [cb] Callback
       * @public
       */
      send(data, options, cb) {
        const perMessageDeflate = this._extensions[PerMessageDeflate2.extensionName];
        let opcode = options.binary ? 2 : 1;
        let rsv1 = options.compress;
        let byteLength;
        let readOnly;
        if (typeof data === "string") {
          byteLength = Buffer.byteLength(data);
          readOnly = false;
        } else if (isBlob(data)) {
          byteLength = data.size;
          readOnly = false;
        } else {
          data = toBuffer(data);
          byteLength = data.length;
          readOnly = toBuffer.readOnly;
        }
        if (this._firstFragment) {
          this._firstFragment = false;
          if (rsv1 && perMessageDeflate && perMessageDeflate.params[perMessageDeflate._isServer ? "server_no_context_takeover" : "client_no_context_takeover"]) {
            rsv1 = byteLength >= perMessageDeflate._threshold;
          }
          this._compress = rsv1;
        } else {
          rsv1 = false;
          opcode = 0;
        }
        if (options.fin) this._firstFragment = true;
        const opts = {
          [kByteLength]: byteLength,
          fin: options.fin,
          generateMask: this._generateMask,
          mask: options.mask,
          maskBuffer: this._maskBuffer,
          opcode,
          readOnly,
          rsv1
        };
        if (isBlob(data)) {
          if (this._state !== DEFAULT) {
            this.enqueue([this.getBlobData, data, this._compress, opts, cb]);
          } else {
            this.getBlobData(data, this._compress, opts, cb);
          }
        } else if (this._state !== DEFAULT) {
          this.enqueue([this.dispatch, data, this._compress, opts, cb]);
        } else {
          this.dispatch(data, this._compress, opts, cb);
        }
      }
      /**
       * Gets the contents of a blob as binary data.
       *
       * @param {Blob} blob The blob
       * @param {Boolean} [compress=false] Specifies whether or not to compress
       *     the data
       * @param {Object} options Options object
       * @param {Boolean} [options.fin=false] Specifies whether or not to set the
       *     FIN bit
       * @param {Function} [options.generateMask] The function used to generate the
       *     masking key
       * @param {Boolean} [options.mask=false] Specifies whether or not to mask
       *     `data`
       * @param {Buffer} [options.maskBuffer] The buffer used to store the masking
       *     key
       * @param {Number} options.opcode The opcode
       * @param {Boolean} [options.readOnly=false] Specifies whether `data` can be
       *     modified
       * @param {Boolean} [options.rsv1=false] Specifies whether or not to set the
       *     RSV1 bit
       * @param {Function} [cb] Callback
       * @private
       */
      getBlobData(blob, compress, options, cb) {
        this._bufferedBytes += options[kByteLength];
        this._state = GET_BLOB_DATA;
        blob.arrayBuffer().then((arrayBuffer) => {
          if (this._socket.destroyed) {
            const err = new Error(
              "The socket was closed while the blob was being read"
            );
            process.nextTick(callCallbacks, this, err, cb);
            return;
          }
          this._bufferedBytes -= options[kByteLength];
          const data = toBuffer(arrayBuffer);
          if (!compress) {
            this._state = DEFAULT;
            this.sendFrame(_Sender.frame(data, options), cb);
            this.dequeue();
          } else {
            this.dispatch(data, compress, options, cb);
          }
        }).catch((err) => {
          process.nextTick(onError, this, err, cb);
        });
      }
      /**
       * Dispatches a message.
       *
       * @param {(Buffer|String)} data The message to send
       * @param {Boolean} [compress=false] Specifies whether or not to compress
       *     `data`
       * @param {Object} options Options object
       * @param {Boolean} [options.fin=false] Specifies whether or not to set the
       *     FIN bit
       * @param {Function} [options.generateMask] The function used to generate the
       *     masking key
       * @param {Boolean} [options.mask=false] Specifies whether or not to mask
       *     `data`
       * @param {Buffer} [options.maskBuffer] The buffer used to store the masking
       *     key
       * @param {Number} options.opcode The opcode
       * @param {Boolean} [options.readOnly=false] Specifies whether `data` can be
       *     modified
       * @param {Boolean} [options.rsv1=false] Specifies whether or not to set the
       *     RSV1 bit
       * @param {Function} [cb] Callback
       * @private
       */
      dispatch(data, compress, options, cb) {
        if (!compress) {
          this.sendFrame(_Sender.frame(data, options), cb);
          return;
        }
        const perMessageDeflate = this._extensions[PerMessageDeflate2.extensionName];
        this._bufferedBytes += options[kByteLength];
        this._state = DEFLATING;
        perMessageDeflate.compress(data, options.fin, (_, buf) => {
          if (this._socket.destroyed) {
            const err = new Error(
              "The socket was closed while data was being compressed"
            );
            callCallbacks(this, err, cb);
            return;
          }
          this._bufferedBytes -= options[kByteLength];
          this._state = DEFAULT;
          options.readOnly = false;
          this.sendFrame(_Sender.frame(buf, options), cb);
          this.dequeue();
        });
      }
      /**
       * Executes queued send operations.
       *
       * @private
       */
      dequeue() {
        while (this._state === DEFAULT && this._queue.length) {
          const params = this._queue.shift();
          this._bufferedBytes -= params[3][kByteLength];
          Reflect.apply(params[0], this, params.slice(1));
        }
      }
      /**
       * Enqueues a send operation.
       *
       * @param {Array} params Send operation parameters.
       * @private
       */
      enqueue(params) {
        this._bufferedBytes += params[3][kByteLength];
        this._queue.push(params);
      }
      /**
       * Sends a frame.
       *
       * @param {(Buffer | String)[]} list The frame to send
       * @param {Function} [cb] Callback
       * @private
       */
      sendFrame(list, cb) {
        if (list.length === 2) {
          this._socket.cork();
          this._socket.write(list[0]);
          this._socket.write(list[1], cb);
          this._socket.uncork();
        } else {
          this._socket.write(list[0], cb);
        }
      }
    };
    module2.exports = Sender2;
    function callCallbacks(sender, err, cb) {
      if (typeof cb === "function") cb(err);
      for (let i = 0; i < sender._queue.length; i++) {
        const params = sender._queue[i];
        const callback = params[params.length - 1];
        if (typeof callback === "function") callback(err);
      }
    }
    function onError(sender, err, cb) {
      callCallbacks(sender, err, cb);
      sender.onerror(err);
    }
  }
});

// ../../node_modules/.pnpm/ws@8.22.1/node_modules/ws/lib/event-target.js
var require_event_target = __commonJS({
  "../../node_modules/.pnpm/ws@8.22.1/node_modules/ws/lib/event-target.js"(exports2, module2) {
    "use strict";
    var { kForOnEventAttribute, kListener } = require_constants();
    var kCode = Symbol("kCode");
    var kData = Symbol("kData");
    var kError = Symbol("kError");
    var kMessage = Symbol("kMessage");
    var kReason = Symbol("kReason");
    var kTarget = Symbol("kTarget");
    var kType = Symbol("kType");
    var kWasClean = Symbol("kWasClean");
    var Event = class {
      /**
       * Create a new `Event`.
       *
       * @param {String} type The name of the event
       * @throws {TypeError} If the `type` argument is not specified
       */
      constructor(type) {
        this[kTarget] = null;
        this[kType] = type;
      }
      /**
       * @type {*}
       */
      get target() {
        return this[kTarget];
      }
      /**
       * @type {String}
       */
      get type() {
        return this[kType];
      }
    };
    Object.defineProperty(Event.prototype, "target", { enumerable: true });
    Object.defineProperty(Event.prototype, "type", { enumerable: true });
    var CloseEvent = class extends Event {
      /**
       * Create a new `CloseEvent`.
       *
       * @param {String} type The name of the event
       * @param {Object} [options] A dictionary object that allows for setting
       *     attributes via object members of the same name
       * @param {Number} [options.code=0] The status code explaining why the
       *     connection was closed
       * @param {String} [options.reason=''] A human-readable string explaining why
       *     the connection was closed
       * @param {Boolean} [options.wasClean=false] Indicates whether or not the
       *     connection was cleanly closed
       */
      constructor(type, options = {}) {
        super(type);
        this[kCode] = options.code === void 0 ? 0 : options.code;
        this[kReason] = options.reason === void 0 ? "" : options.reason;
        this[kWasClean] = options.wasClean === void 0 ? false : options.wasClean;
      }
      /**
       * @type {Number}
       */
      get code() {
        return this[kCode];
      }
      /**
       * @type {String}
       */
      get reason() {
        return this[kReason];
      }
      /**
       * @type {Boolean}
       */
      get wasClean() {
        return this[kWasClean];
      }
    };
    Object.defineProperty(CloseEvent.prototype, "code", { enumerable: true });
    Object.defineProperty(CloseEvent.prototype, "reason", { enumerable: true });
    Object.defineProperty(CloseEvent.prototype, "wasClean", { enumerable: true });
    var ErrorEvent = class extends Event {
      /**
       * Create a new `ErrorEvent`.
       *
       * @param {String} type The name of the event
       * @param {Object} [options] A dictionary object that allows for setting
       *     attributes via object members of the same name
       * @param {*} [options.error=null] The error that generated this event
       * @param {String} [options.message=''] The error message
       */
      constructor(type, options = {}) {
        super(type);
        this[kError] = options.error === void 0 ? null : options.error;
        this[kMessage] = options.message === void 0 ? "" : options.message;
      }
      /**
       * @type {*}
       */
      get error() {
        return this[kError];
      }
      /**
       * @type {String}
       */
      get message() {
        return this[kMessage];
      }
    };
    Object.defineProperty(ErrorEvent.prototype, "error", { enumerable: true });
    Object.defineProperty(ErrorEvent.prototype, "message", { enumerable: true });
    var MessageEvent = class extends Event {
      /**
       * Create a new `MessageEvent`.
       *
       * @param {String} type The name of the event
       * @param {Object} [options] A dictionary object that allows for setting
       *     attributes via object members of the same name
       * @param {*} [options.data=null] The message content
       */
      constructor(type, options = {}) {
        super(type);
        this[kData] = options.data === void 0 ? null : options.data;
      }
      /**
       * @type {*}
       */
      get data() {
        return this[kData];
      }
    };
    Object.defineProperty(MessageEvent.prototype, "data", { enumerable: true });
    var EventTarget = {
      /**
       * Register an event listener.
       *
       * @param {String} type A string representing the event type to listen for
       * @param {(Function|Object)} handler The listener to add
       * @param {Object} [options] An options object specifies characteristics about
       *     the event listener
       * @param {Boolean} [options.once=false] A `Boolean` indicating that the
       *     listener should be invoked at most once after being added. If `true`,
       *     the listener would be automatically removed when invoked.
       * @public
       */
      addEventListener(type, handler, options = {}) {
        for (const listener of this.listeners(type)) {
          if (!options[kForOnEventAttribute] && listener[kListener] === handler && !listener[kForOnEventAttribute]) {
            return;
          }
        }
        let wrapper;
        if (type === "message") {
          wrapper = function onMessage(data, isBinary) {
            const event = new MessageEvent("message", {
              data: isBinary ? data : data.toString()
            });
            event[kTarget] = this;
            callListener(handler, this, event);
          };
        } else if (type === "close") {
          wrapper = function onClose(code, message) {
            const event = new CloseEvent("close", {
              code,
              reason: message.toString(),
              wasClean: this._closeFrameReceived && this._closeFrameSent
            });
            event[kTarget] = this;
            callListener(handler, this, event);
          };
        } else if (type === "error") {
          wrapper = function onError(error) {
            const event = new ErrorEvent("error", {
              error,
              message: error.message
            });
            event[kTarget] = this;
            callListener(handler, this, event);
          };
        } else if (type === "open") {
          wrapper = function onOpen() {
            const event = new Event("open");
            event[kTarget] = this;
            callListener(handler, this, event);
          };
        } else {
          return;
        }
        wrapper[kForOnEventAttribute] = !!options[kForOnEventAttribute];
        wrapper[kListener] = handler;
        if (options.once) {
          this.once(type, wrapper);
        } else {
          this.on(type, wrapper);
        }
      },
      /**
       * Remove an event listener.
       *
       * @param {String} type A string representing the event type to remove
       * @param {(Function|Object)} handler The listener to remove
       * @public
       */
      removeEventListener(type, handler) {
        for (const listener of this.listeners(type)) {
          if (listener[kListener] === handler && !listener[kForOnEventAttribute]) {
            this.removeListener(type, listener);
            break;
          }
        }
      }
    };
    module2.exports = {
      CloseEvent,
      ErrorEvent,
      Event,
      EventTarget,
      MessageEvent
    };
    function callListener(listener, thisArg, event) {
      if (typeof listener === "object" && listener.handleEvent) {
        listener.handleEvent.call(listener, event);
      } else {
        listener.call(thisArg, event);
      }
    }
  }
});

// ../../node_modules/.pnpm/ws@8.22.1/node_modules/ws/lib/extension.js
var require_extension = __commonJS({
  "../../node_modules/.pnpm/ws@8.22.1/node_modules/ws/lib/extension.js"(exports2, module2) {
    "use strict";
    var { tokenChars } = require_validation();
    function push(dest, name, elem) {
      if (dest[name] === void 0) dest[name] = [elem];
      else dest[name].push(elem);
    }
    function parse(header) {
      const offers = /* @__PURE__ */ Object.create(null);
      let params = /* @__PURE__ */ Object.create(null);
      let mustUnescape = false;
      let isEscaping = false;
      let inQuotes = false;
      let extensionName;
      let paramName;
      let start = -1;
      let code = -1;
      let end = -1;
      let i = 0;
      for (; i < header.length; i++) {
        code = header.charCodeAt(i);
        if (extensionName === void 0) {
          if (end === -1 && tokenChars[code] === 1) {
            if (start === -1) start = i;
          } else if (i !== 0 && (code === 32 || code === 9)) {
            if (end === -1 && start !== -1) end = i;
          } else if (code === 59 || code === 44) {
            if (start === -1) {
              throw new SyntaxError(`Unexpected character at index ${i}`);
            }
            if (end === -1) end = i;
            const name = header.slice(start, end);
            if (code === 44) {
              push(offers, name, params);
              params = /* @__PURE__ */ Object.create(null);
            } else {
              extensionName = name;
            }
            start = end = -1;
          } else {
            throw new SyntaxError(`Unexpected character at index ${i}`);
          }
        } else if (paramName === void 0) {
          if (end === -1 && tokenChars[code] === 1) {
            if (start === -1) start = i;
          } else if (code === 32 || code === 9) {
            if (end === -1 && start !== -1) end = i;
          } else if (code === 59 || code === 44) {
            if (start === -1) {
              throw new SyntaxError(`Unexpected character at index ${i}`);
            }
            if (end === -1) end = i;
            push(params, header.slice(start, end), true);
            if (code === 44) {
              push(offers, extensionName, params);
              params = /* @__PURE__ */ Object.create(null);
              extensionName = void 0;
            }
            start = end = -1;
          } else if (code === 61 && start !== -1 && end === -1) {
            paramName = header.slice(start, i);
            start = end = -1;
          } else {
            throw new SyntaxError(`Unexpected character at index ${i}`);
          }
        } else {
          if (isEscaping) {
            if (tokenChars[code] !== 1) {
              throw new SyntaxError(`Unexpected character at index ${i}`);
            }
            if (start === -1) start = i;
            else if (!mustUnescape) mustUnescape = true;
            isEscaping = false;
          } else if (inQuotes) {
            if (tokenChars[code] === 1) {
              if (start === -1) start = i;
            } else if (code === 34 && start !== -1) {
              inQuotes = false;
              end = i;
            } else if (code === 92) {
              isEscaping = true;
            } else {
              throw new SyntaxError(`Unexpected character at index ${i}`);
            }
          } else if (code === 34 && header.charCodeAt(i - 1) === 61) {
            inQuotes = true;
          } else if (end === -1 && tokenChars[code] === 1) {
            if (start === -1) start = i;
          } else if (start !== -1 && (code === 32 || code === 9)) {
            if (end === -1) end = i;
          } else if (code === 59 || code === 44) {
            if (start === -1) {
              throw new SyntaxError(`Unexpected character at index ${i}`);
            }
            if (end === -1) end = i;
            let value = header.slice(start, end);
            if (mustUnescape) {
              value = value.replace(/\\/g, "");
              mustUnescape = false;
            }
            push(params, paramName, value);
            if (code === 44) {
              push(offers, extensionName, params);
              params = /* @__PURE__ */ Object.create(null);
              extensionName = void 0;
            }
            paramName = void 0;
            start = end = -1;
          } else {
            throw new SyntaxError(`Unexpected character at index ${i}`);
          }
        }
      }
      if (start === -1 || inQuotes || code === 32 || code === 9) {
        throw new SyntaxError("Unexpected end of input");
      }
      if (end === -1) end = i;
      const token = header.slice(start, end);
      if (extensionName === void 0) {
        push(offers, token, params);
      } else {
        if (paramName === void 0) {
          push(params, token, true);
        } else if (mustUnescape) {
          push(params, paramName, token.replace(/\\/g, ""));
        } else {
          push(params, paramName, token);
        }
        push(offers, extensionName, params);
      }
      return offers;
    }
    function format(extensions) {
      return Object.keys(extensions).map((extension2) => {
        let configurations = extensions[extension2];
        if (!Array.isArray(configurations)) configurations = [configurations];
        return configurations.map((params) => {
          return [extension2].concat(
            Object.keys(params).map((k) => {
              let values = params[k];
              if (!Array.isArray(values)) values = [values];
              return values.map((v) => v === true ? k : `${k}=${v}`).join("; ");
            })
          ).join("; ");
        }).join(", ");
      }).join(", ");
    }
    module2.exports = { format, parse };
  }
});

// ../../node_modules/.pnpm/ws@8.22.1/node_modules/ws/lib/websocket.js
var require_websocket = __commonJS({
  "../../node_modules/.pnpm/ws@8.22.1/node_modules/ws/lib/websocket.js"(exports2, module2) {
    "use strict";
    var EventEmitter = require("events");
    var https = require("https");
    var http2 = require("http");
    var net = require("net");
    var tls = require("tls");
    var { randomBytes, createHash } = require("crypto");
    var { Duplex, Readable } = require("stream");
    var { URL: URL2 } = require("url");
    var PerMessageDeflate2 = require_permessage_deflate();
    var Receiver2 = require_receiver();
    var Sender2 = require_sender();
    var { isBlob } = require_validation();
    var {
      BINARY_TYPES,
      CLOSE_TIMEOUT,
      EMPTY_BUFFER,
      GUID,
      kForOnEventAttribute,
      kListener,
      kStatusCode,
      kWebSocket,
      NOOP
    } = require_constants();
    var {
      EventTarget: { addEventListener, removeEventListener }
    } = require_event_target();
    var { format, parse } = require_extension();
    var { toBuffer } = require_buffer_util();
    var kAborted = Symbol("kAborted");
    var protocolVersions = [8, 13];
    var readyStates = ["CONNECTING", "OPEN", "CLOSING", "CLOSED"];
    var subprotocolRegex = /^[!#$%&'*+\-.0-9A-Z^_`|a-z~]+$/;
    var WebSocket2 = class _WebSocket extends EventEmitter {
      /**
       * Create a new `WebSocket`.
       *
       * @param {(String|URL)} address The URL to which to connect
       * @param {(String|String[])} [protocols] The subprotocols
       * @param {Object} [options] Connection options
       */
      constructor(address, protocols, options) {
        super();
        this._binaryType = BINARY_TYPES[0];
        this._closeCode = 1006;
        this._closeFrameReceived = false;
        this._closeFrameSent = false;
        this._closeMessage = EMPTY_BUFFER;
        this._closeTimer = null;
        this._errorEmitted = false;
        this._extensions = {};
        this._paused = false;
        this._protocol = "";
        this._readyState = _WebSocket.CONNECTING;
        this._receiver = null;
        this._sender = null;
        this._socket = null;
        if (address !== null) {
          this._bufferedAmount = 0;
          this._isServer = false;
          this._redirects = 0;
          if (protocols === void 0) {
            if (!options || options.protocols === void 0) {
              protocols = [];
            } else if (Array.isArray(options.protocols)) {
              protocols = options.protocols;
            } else {
              protocols = [options.protocols];
            }
          } else if (!Array.isArray(protocols)) {
            if (typeof protocols === "object" && protocols !== null) {
              options = protocols;
              if (options.protocols === void 0) {
                protocols = [];
              } else if (Array.isArray(options.protocols)) {
                protocols = options.protocols;
              } else {
                protocols = [options.protocols];
              }
            } else {
              protocols = [protocols];
            }
          }
          initAsClient(this, address, protocols, options);
        } else {
          this._autoPong = options.autoPong;
          this._closeTimeout = options.closeTimeout;
          this._isServer = true;
        }
      }
      /**
       * For historical reasons, the custom "nodebuffer" type is used by the default
       * instead of "blob".
       *
       * @type {String}
       */
      get binaryType() {
        return this._binaryType;
      }
      set binaryType(type) {
        if (!BINARY_TYPES.includes(type)) return;
        this._binaryType = type;
        if (this._receiver) this._receiver._binaryType = type;
      }
      /**
       * @type {Number}
       */
      get bufferedAmount() {
        if (!this._socket) return this._bufferedAmount;
        return this._socket._writableState.length + this._sender._bufferedBytes;
      }
      /**
       * @type {String}
       */
      get extensions() {
        return Object.keys(this._extensions).join();
      }
      /**
       * @type {Boolean}
       */
      get isPaused() {
        return this._paused;
      }
      /**
       * @type {Function}
       */
      /* istanbul ignore next */
      get onclose() {
        return null;
      }
      /**
       * @type {Function}
       */
      /* istanbul ignore next */
      get onerror() {
        return null;
      }
      /**
       * @type {Function}
       */
      /* istanbul ignore next */
      get onopen() {
        return null;
      }
      /**
       * @type {Function}
       */
      /* istanbul ignore next */
      get onmessage() {
        return null;
      }
      /**
       * @type {String}
       */
      get protocol() {
        return this._protocol;
      }
      /**
       * @type {Number}
       */
      get readyState() {
        return this._readyState;
      }
      /**
       * @type {String}
       */
      get url() {
        return this._url;
      }
      /**
       * Set up the socket and the internal resources.
       *
       * @param {Duplex} socket The network socket between the server and client
       * @param {Buffer} head The first packet of the upgraded stream
       * @param {Object} options Options object
       * @param {Boolean} [options.allowSynchronousEvents=false] Specifies whether
       *     any of the `'message'`, `'ping'`, and `'pong'` events can be emitted
       *     multiple times in the same tick
       * @param {Function} [options.generateMask] The function used to generate the
       *     masking key
       * @param {Number} [options.maxBufferedChunks=0] The maximum number of
       *     buffered data chunks
       * @param {Number} [options.maxFragments=0] The maximum number of message
       *     fragments
       * @param {Number} [options.maxPayload=0] The maximum allowed message size
       * @param {Boolean} [options.skipUTF8Validation=false] Specifies whether or
       *     not to skip UTF-8 validation for text and close messages
       * @private
       */
      setSocket(socket, head, options) {
        const receiver = new Receiver2({
          allowSynchronousEvents: options.allowSynchronousEvents,
          binaryType: this.binaryType,
          extensions: this._extensions,
          isServer: this._isServer,
          maxBufferedChunks: options.maxBufferedChunks,
          maxFragments: options.maxFragments,
          maxPayload: options.maxPayload,
          skipUTF8Validation: options.skipUTF8Validation
        });
        const sender = new Sender2(socket, this._extensions, options.generateMask);
        this._receiver = receiver;
        this._sender = sender;
        this._socket = socket;
        receiver[kWebSocket] = this;
        sender[kWebSocket] = this;
        socket[kWebSocket] = this;
        receiver.on("conclude", receiverOnConclude);
        receiver.on("drain", receiverOnDrain);
        receiver.on("error", receiverOnError);
        receiver.on("message", receiverOnMessage);
        receiver.on("ping", receiverOnPing);
        receiver.on("pong", receiverOnPong);
        sender.onerror = senderOnError;
        if (socket.setTimeout) socket.setTimeout(0);
        if (socket.setNoDelay) socket.setNoDelay();
        if (head.length > 0) socket.unshift(head);
        socket.on("close", socketOnClose);
        socket.on("data", socketOnData);
        socket.on("end", socketOnEnd);
        socket.on("error", socketOnError);
        this._readyState = _WebSocket.OPEN;
        this.emit("open");
      }
      /**
       * Emit the `'close'` event.
       *
       * @private
       */
      emitClose() {
        if (!this._socket) {
          this._readyState = _WebSocket.CLOSED;
          this.emit("close", this._closeCode, this._closeMessage);
          return;
        }
        if (this._extensions[PerMessageDeflate2.extensionName]) {
          this._extensions[PerMessageDeflate2.extensionName].cleanup();
        }
        this._receiver.removeAllListeners();
        this._readyState = _WebSocket.CLOSED;
        this.emit("close", this._closeCode, this._closeMessage);
      }
      /**
       * Start a closing handshake.
       *
       *          +----------+   +-----------+   +----------+
       *     - - -|ws.close()|-->|close frame|-->|ws.close()|- - -
       *    |     +----------+   +-----------+   +----------+     |
       *          +----------+   +-----------+         |
       * CLOSING  |ws.close()|<--|close frame|<--+-----+       CLOSING
       *          +----------+   +-----------+   |
       *    |           |                        |   +---+        |
       *                +------------------------+-->|fin| - - - -
       *    |         +---+                      |   +---+
       *     - - - - -|fin|<---------------------+
       *              +---+
       *
       * @param {Number} [code] Status code explaining why the connection is closing
       * @param {(String|Buffer)} [data] The reason why the connection is
       *     closing
       * @public
       */
      close(code, data) {
        if (this.readyState === _WebSocket.CLOSED) return;
        if (this.readyState === _WebSocket.CONNECTING) {
          const msg = "WebSocket was closed before the connection was established";
          abortHandshake(this, this._req, msg);
          return;
        }
        if (this.readyState === _WebSocket.CLOSING) {
          if (this._closeFrameSent && (this._closeFrameReceived || this._receiver._writableState.errorEmitted)) {
            this._socket.end();
          }
          return;
        }
        this._sender.close(code, data, !this._isServer, (err) => {
          if (err) return;
          this._closeFrameSent = true;
          if (this._closeFrameReceived || this._receiver._writableState.errorEmitted) {
            this._socket.end();
          }
        });
        this._readyState = _WebSocket.CLOSING;
        setCloseTimer(this);
      }
      /**
       * Pause the socket.
       *
       * @public
       */
      pause() {
        if (this.readyState === _WebSocket.CONNECTING || this.readyState === _WebSocket.CLOSED) {
          return;
        }
        this._paused = true;
        this._socket.pause();
      }
      /**
       * Send a ping.
       *
       * @param {*} [data] The data to send
       * @param {Boolean} [mask] Indicates whether or not to mask `data`
       * @param {Function} [cb] Callback which is executed when the ping is sent
       * @public
       */
      ping(data, mask, cb) {
        if (this.readyState === _WebSocket.CONNECTING) {
          throw new Error("WebSocket is not open: readyState 0 (CONNECTING)");
        }
        if (typeof data === "function") {
          cb = data;
          data = mask = void 0;
        } else if (typeof mask === "function") {
          cb = mask;
          mask = void 0;
        }
        if (typeof data === "number") data = data.toString();
        if (this.readyState !== _WebSocket.OPEN) {
          sendAfterClose(this, data, cb);
          return;
        }
        if (mask === void 0) mask = !this._isServer;
        this._sender.ping(data || EMPTY_BUFFER, mask, cb);
      }
      /**
       * Send a pong.
       *
       * @param {*} [data] The data to send
       * @param {Boolean} [mask] Indicates whether or not to mask `data`
       * @param {Function} [cb] Callback which is executed when the pong is sent
       * @public
       */
      pong(data, mask, cb) {
        if (this.readyState === _WebSocket.CONNECTING) {
          throw new Error("WebSocket is not open: readyState 0 (CONNECTING)");
        }
        if (typeof data === "function") {
          cb = data;
          data = mask = void 0;
        } else if (typeof mask === "function") {
          cb = mask;
          mask = void 0;
        }
        if (typeof data === "number") data = data.toString();
        if (this.readyState !== _WebSocket.OPEN) {
          sendAfterClose(this, data, cb);
          return;
        }
        if (mask === void 0) mask = !this._isServer;
        this._sender.pong(data || EMPTY_BUFFER, mask, cb);
      }
      /**
       * Resume the socket.
       *
       * @public
       */
      resume() {
        if (this.readyState === _WebSocket.CONNECTING || this.readyState === _WebSocket.CLOSED) {
          return;
        }
        this._paused = false;
        if (!this._receiver._writableState.needDrain) this._socket.resume();
      }
      /**
       * Send a data message.
       *
       * @param {*} data The message to send
       * @param {Object} [options] Options object
       * @param {Boolean} [options.binary] Specifies whether `data` is binary or
       *     text
       * @param {Boolean} [options.compress] Specifies whether or not to compress
       *     `data`
       * @param {Boolean} [options.fin=true] Specifies whether the fragment is the
       *     last one
       * @param {Boolean} [options.mask] Specifies whether or not to mask `data`
       * @param {Function} [cb] Callback which is executed when data is written out
       * @public
       */
      send(data, options, cb) {
        if (this.readyState === _WebSocket.CONNECTING) {
          throw new Error("WebSocket is not open: readyState 0 (CONNECTING)");
        }
        if (typeof options === "function") {
          cb = options;
          options = {};
        }
        if (typeof data === "number") data = data.toString();
        if (this.readyState !== _WebSocket.OPEN) {
          sendAfterClose(this, data, cb);
          return;
        }
        const opts = {
          binary: typeof data !== "string",
          mask: !this._isServer,
          compress: true,
          fin: true,
          ...options
        };
        if (!this._extensions[PerMessageDeflate2.extensionName]) {
          opts.compress = false;
        }
        this._sender.send(data || EMPTY_BUFFER, opts, cb);
      }
      /**
       * Forcibly close the connection.
       *
       * @public
       */
      terminate() {
        if (this.readyState === _WebSocket.CLOSED) return;
        if (this.readyState === _WebSocket.CONNECTING) {
          const msg = "WebSocket was closed before the connection was established";
          abortHandshake(this, this._req, msg);
          return;
        }
        if (this._socket) {
          this._readyState = _WebSocket.CLOSING;
          this._socket.destroy();
        }
      }
    };
    Object.defineProperty(WebSocket2, "CONNECTING", {
      enumerable: true,
      value: readyStates.indexOf("CONNECTING")
    });
    Object.defineProperty(WebSocket2.prototype, "CONNECTING", {
      enumerable: true,
      value: readyStates.indexOf("CONNECTING")
    });
    Object.defineProperty(WebSocket2, "OPEN", {
      enumerable: true,
      value: readyStates.indexOf("OPEN")
    });
    Object.defineProperty(WebSocket2.prototype, "OPEN", {
      enumerable: true,
      value: readyStates.indexOf("OPEN")
    });
    Object.defineProperty(WebSocket2, "CLOSING", {
      enumerable: true,
      value: readyStates.indexOf("CLOSING")
    });
    Object.defineProperty(WebSocket2.prototype, "CLOSING", {
      enumerable: true,
      value: readyStates.indexOf("CLOSING")
    });
    Object.defineProperty(WebSocket2, "CLOSED", {
      enumerable: true,
      value: readyStates.indexOf("CLOSED")
    });
    Object.defineProperty(WebSocket2.prototype, "CLOSED", {
      enumerable: true,
      value: readyStates.indexOf("CLOSED")
    });
    [
      "binaryType",
      "bufferedAmount",
      "extensions",
      "isPaused",
      "protocol",
      "readyState",
      "url"
    ].forEach((property) => {
      Object.defineProperty(WebSocket2.prototype, property, { enumerable: true });
    });
    ["open", "error", "close", "message"].forEach((method) => {
      Object.defineProperty(WebSocket2.prototype, `on${method}`, {
        enumerable: true,
        get() {
          for (const listener of this.listeners(method)) {
            if (listener[kForOnEventAttribute]) return listener[kListener];
          }
          return null;
        },
        set(handler) {
          for (const listener of this.listeners(method)) {
            if (listener[kForOnEventAttribute]) {
              this.removeListener(method, listener);
              break;
            }
          }
          if (typeof handler !== "function") return;
          this.addEventListener(method, handler, {
            [kForOnEventAttribute]: true
          });
        }
      });
    });
    WebSocket2.prototype.addEventListener = addEventListener;
    WebSocket2.prototype.removeEventListener = removeEventListener;
    module2.exports = WebSocket2;
    function initAsClient(websocket, address, protocols, options) {
      const opts = {
        allowSynchronousEvents: true,
        autoPong: true,
        closeTimeout: CLOSE_TIMEOUT,
        protocolVersion: protocolVersions[1],
        maxBufferedChunks: 256 * 1024,
        maxFragments: 16 * 1024,
        maxPayload: 100 * 1024 * 1024,
        skipUTF8Validation: false,
        perMessageDeflate: true,
        followRedirects: false,
        maxRedirects: 10,
        ...options,
        socketPath: void 0,
        hostname: void 0,
        protocol: void 0,
        protocols: void 0,
        timeout: void 0,
        method: "GET",
        host: void 0,
        path: void 0,
        port: void 0
      };
      websocket._autoPong = opts.autoPong;
      websocket._closeTimeout = opts.closeTimeout;
      if (!protocolVersions.includes(opts.protocolVersion)) {
        throw new RangeError(
          `Unsupported protocol version: ${opts.protocolVersion} (supported versions: ${protocolVersions.join(", ")})`
        );
      }
      let parsedUrl;
      if (address instanceof URL2) {
        parsedUrl = address;
      } else {
        try {
          parsedUrl = new URL2(address);
        } catch {
          throw new SyntaxError(`Invalid URL: ${address}`);
        }
      }
      if (parsedUrl.protocol === "http:") {
        parsedUrl.protocol = "ws:";
      } else if (parsedUrl.protocol === "https:") {
        parsedUrl.protocol = "wss:";
      }
      websocket._url = parsedUrl.href;
      const isSecure = parsedUrl.protocol === "wss:";
      const isIpcUrl = parsedUrl.protocol === "ws+unix:";
      let invalidUrlMessage;
      if (parsedUrl.protocol !== "ws:" && !isSecure && !isIpcUrl) {
        invalidUrlMessage = `The URL's protocol must be one of "ws:", "wss:", "http:", "https:", or "ws+unix:"`;
      } else if (isIpcUrl && !parsedUrl.pathname) {
        invalidUrlMessage = "The URL's pathname is empty";
      } else if (parsedUrl.hash) {
        invalidUrlMessage = "The URL contains a fragment identifier";
      }
      if (invalidUrlMessage) {
        const err = new SyntaxError(invalidUrlMessage);
        if (websocket._redirects === 0) {
          throw err;
        } else {
          emitErrorAndClose(websocket, err);
          return;
        }
      }
      const defaultPort = isSecure ? 443 : 80;
      const key = randomBytes(16).toString("base64");
      const request = isSecure ? https.request : http2.request;
      const protocolSet = /* @__PURE__ */ new Set();
      let perMessageDeflate;
      opts.createConnection = opts.createConnection || (isSecure ? tlsConnect : netConnect);
      opts.defaultPort = opts.defaultPort || defaultPort;
      opts.port = parsedUrl.port || defaultPort;
      opts.host = parsedUrl.hostname.startsWith("[") ? parsedUrl.hostname.slice(1, -1) : parsedUrl.hostname;
      opts.headers = {
        ...opts.headers,
        "Sec-WebSocket-Version": opts.protocolVersion,
        "Sec-WebSocket-Key": key,
        Connection: "Upgrade",
        Upgrade: "websocket"
      };
      opts.path = parsedUrl.pathname + parsedUrl.search;
      opts.timeout = opts.handshakeTimeout;
      if (opts.perMessageDeflate) {
        perMessageDeflate = new PerMessageDeflate2({
          ...opts.perMessageDeflate,
          isServer: false,
          maxPayload: opts.maxPayload
        });
        opts.headers["Sec-WebSocket-Extensions"] = format({
          [PerMessageDeflate2.extensionName]: perMessageDeflate.offer()
        });
      }
      if (protocols.length) {
        for (const protocol of protocols) {
          if (typeof protocol !== "string" || !subprotocolRegex.test(protocol) || protocolSet.has(protocol)) {
            throw new SyntaxError(
              "An invalid or duplicated subprotocol was specified"
            );
          }
          protocolSet.add(protocol);
        }
        opts.headers["Sec-WebSocket-Protocol"] = protocols.join(",");
      }
      if (opts.origin) {
        if (opts.protocolVersion < 13) {
          opts.headers["Sec-WebSocket-Origin"] = opts.origin;
        } else {
          opts.headers.Origin = opts.origin;
        }
      }
      if (parsedUrl.username || parsedUrl.password) {
        opts.auth = `${parsedUrl.username}:${parsedUrl.password}`;
      }
      if (isIpcUrl) {
        const i = opts.path.indexOf(":");
        if (i === -1) {
          opts.socketPath = opts.path;
          opts.path = "";
        } else {
          opts.socketPath = opts.path.slice(0, i);
          opts.path = opts.path.slice(i + 1);
        }
      }
      let req;
      if (opts.followRedirects) {
        if (websocket._redirects === 0) {
          websocket._originalIpc = isIpcUrl;
          websocket._originalSecure = isSecure;
          websocket._originalHostOrSocketPath = isIpcUrl ? opts.socketPath : parsedUrl.host;
          const headers = options && options.headers;
          options = { ...options, headers: {} };
          if (headers) {
            for (const [key2, value] of Object.entries(headers)) {
              options.headers[key2.toLowerCase()] = value;
            }
          }
        } else if (websocket.listenerCount("redirect") === 0) {
          const isSameHost = isIpcUrl ? websocket._originalIpc ? opts.socketPath === websocket._originalHostOrSocketPath : false : websocket._originalIpc ? false : parsedUrl.host === websocket._originalHostOrSocketPath;
          if (!isSameHost || websocket._originalSecure && !isSecure) {
            delete opts.headers.authorization;
            delete opts.headers.cookie;
            if (!isSameHost) delete opts.headers.host;
            opts.auth = void 0;
          }
        }
        if (opts.auth && !options.headers.authorization) {
          options.headers.authorization = "Basic " + Buffer.from(opts.auth).toString("base64");
        }
        req = websocket._req = request(opts);
        if (websocket._redirects) {
          websocket.emit("redirect", websocket.url, req);
        }
      } else {
        req = websocket._req = request(opts);
      }
      if (opts.timeout) {
        req.on("timeout", () => {
          abortHandshake(websocket, req, "Opening handshake has timed out");
        });
      }
      req.on("error", (err) => {
        if (req === null || req[kAborted]) return;
        req = websocket._req = null;
        emitErrorAndClose(websocket, err);
      });
      req.on("response", (res) => {
        const location = res.headers.location;
        const statusCode = res.statusCode;
        if (location && opts.followRedirects && statusCode >= 300 && statusCode < 400) {
          if (++websocket._redirects > opts.maxRedirects) {
            abortHandshake(websocket, req, "Maximum redirects exceeded");
            return;
          }
          req.abort();
          let addr;
          try {
            addr = new URL2(location, address);
          } catch (e) {
            const err = new SyntaxError(`Invalid URL: ${location}`);
            emitErrorAndClose(websocket, err);
            return;
          }
          initAsClient(websocket, addr, protocols, options);
        } else if (!websocket.emit("unexpected-response", req, res)) {
          abortHandshake(
            websocket,
            req,
            `Unexpected server response: ${res.statusCode}`
          );
        }
      });
      req.on("upgrade", (res, socket, head) => {
        websocket.emit("upgrade", res);
        if (websocket.readyState !== WebSocket2.CONNECTING) return;
        req = websocket._req = null;
        const upgrade = res.headers.upgrade;
        if (upgrade === void 0 || upgrade.toLowerCase() !== "websocket") {
          abortHandshake(websocket, socket, "Invalid Upgrade header");
          return;
        }
        const digest = createHash("sha1").update(key + GUID).digest("base64");
        if (res.headers["sec-websocket-accept"] !== digest) {
          abortHandshake(websocket, socket, "Invalid Sec-WebSocket-Accept header");
          return;
        }
        const serverProt = res.headers["sec-websocket-protocol"];
        let protError;
        if (serverProt !== void 0) {
          if (!protocolSet.size) {
            protError = "Server sent a subprotocol but none was requested";
          } else if (!protocolSet.has(serverProt)) {
            protError = "Server sent an invalid subprotocol";
          }
        } else if (protocolSet.size) {
          protError = "Server sent no subprotocol";
        }
        if (protError) {
          abortHandshake(websocket, socket, protError);
          return;
        }
        if (serverProt) websocket._protocol = serverProt;
        const secWebSocketExtensions = res.headers["sec-websocket-extensions"];
        if (secWebSocketExtensions !== void 0) {
          if (!perMessageDeflate) {
            const message = "Server sent a Sec-WebSocket-Extensions header but no extension was requested";
            abortHandshake(websocket, socket, message);
            return;
          }
          let extensions;
          try {
            extensions = parse(secWebSocketExtensions);
          } catch (err) {
            const message = "Invalid Sec-WebSocket-Extensions header";
            abortHandshake(websocket, socket, message);
            return;
          }
          const extensionNames = Object.keys(extensions);
          if (extensionNames.length !== 1 || extensionNames[0] !== PerMessageDeflate2.extensionName) {
            const message = "Server indicated an extension that was not requested";
            abortHandshake(websocket, socket, message);
            return;
          }
          try {
            perMessageDeflate.accept(extensions[PerMessageDeflate2.extensionName]);
          } catch (err) {
            const message = "Invalid Sec-WebSocket-Extensions header";
            abortHandshake(websocket, socket, message);
            return;
          }
          websocket._extensions[PerMessageDeflate2.extensionName] = perMessageDeflate;
        }
        websocket.setSocket(socket, head, {
          allowSynchronousEvents: opts.allowSynchronousEvents,
          generateMask: opts.generateMask,
          maxBufferedChunks: opts.maxBufferedChunks,
          maxFragments: opts.maxFragments,
          maxPayload: opts.maxPayload,
          skipUTF8Validation: opts.skipUTF8Validation
        });
      });
      if (opts.finishRequest) {
        opts.finishRequest(req, websocket);
      } else {
        req.end();
      }
    }
    function emitErrorAndClose(websocket, err) {
      websocket._readyState = WebSocket2.CLOSING;
      websocket._errorEmitted = true;
      websocket.emit("error", err);
      websocket.emitClose();
    }
    function netConnect(options) {
      options.path = options.socketPath;
      return net.connect(options);
    }
    function tlsConnect(options) {
      options.path = void 0;
      if (!options.servername && options.servername !== "") {
        options.servername = net.isIP(options.host) ? "" : options.host;
      }
      return tls.connect(options);
    }
    function abortHandshake(websocket, stream, message) {
      websocket._readyState = WebSocket2.CLOSING;
      const err = new Error(message);
      Error.captureStackTrace(err, abortHandshake);
      if (stream.setHeader) {
        stream[kAborted] = true;
        stream.abort();
        if (stream.socket && !stream.socket.destroyed) {
          stream.socket.destroy();
        }
        process.nextTick(emitErrorAndClose, websocket, err);
      } else {
        stream.destroy(err);
        stream.once("error", websocket.emit.bind(websocket, "error"));
        stream.once("close", websocket.emitClose.bind(websocket));
      }
    }
    function sendAfterClose(websocket, data, cb) {
      if (data) {
        const length = isBlob(data) ? data.size : toBuffer(data).length;
        if (websocket._socket) websocket._sender._bufferedBytes += length;
        else websocket._bufferedAmount += length;
      }
      if (cb) {
        const err = new Error(
          `WebSocket is not open: readyState ${websocket.readyState} (${readyStates[websocket.readyState]})`
        );
        process.nextTick(cb, err);
      }
    }
    function receiverOnConclude(code, reason) {
      const websocket = this[kWebSocket];
      websocket._closeFrameReceived = true;
      websocket._closeMessage = reason;
      websocket._closeCode = code;
      if (websocket._socket[kWebSocket] === void 0) return;
      websocket._socket.removeListener("data", socketOnData);
      process.nextTick(resume, websocket._socket);
      if (code === 1005) websocket.close();
      else websocket.close(code, reason);
    }
    function receiverOnDrain() {
      const websocket = this[kWebSocket];
      if (!websocket.isPaused) websocket._socket.resume();
    }
    function receiverOnError(err) {
      const websocket = this[kWebSocket];
      if (websocket._socket[kWebSocket] !== void 0) {
        websocket._socket.removeListener("data", socketOnData);
        process.nextTick(resume, websocket._socket);
        websocket.close(err[kStatusCode]);
      }
      if (!websocket._errorEmitted) {
        websocket._errorEmitted = true;
        websocket.emit("error", err);
      }
    }
    function receiverOnFinish() {
      this[kWebSocket].emitClose();
    }
    function receiverOnMessage(data, isBinary) {
      this[kWebSocket].emit("message", data, isBinary);
    }
    function receiverOnPing(data) {
      const websocket = this[kWebSocket];
      if (websocket._autoPong) websocket.pong(data, !this._isServer, NOOP);
      websocket.emit("ping", data);
    }
    function receiverOnPong(data) {
      this[kWebSocket].emit("pong", data);
    }
    function resume(stream) {
      stream.resume();
    }
    function senderOnError(err) {
      const websocket = this[kWebSocket];
      if (websocket.readyState === WebSocket2.CLOSED) return;
      if (websocket.readyState === WebSocket2.OPEN) {
        websocket._readyState = WebSocket2.CLOSING;
        setCloseTimer(websocket);
      }
      this._socket.end();
      if (!websocket._errorEmitted) {
        websocket._errorEmitted = true;
        websocket.emit("error", err);
      }
    }
    function setCloseTimer(websocket) {
      websocket._closeTimer = setTimeout(
        websocket._socket.destroy.bind(websocket._socket),
        websocket._closeTimeout
      );
    }
    function socketOnClose() {
      const websocket = this[kWebSocket];
      this.removeListener("close", socketOnClose);
      this.removeListener("data", socketOnData);
      this.removeListener("end", socketOnEnd);
      websocket._readyState = WebSocket2.CLOSING;
      if (!this._readableState.endEmitted && !websocket._closeFrameReceived && !websocket._receiver._writableState.errorEmitted && this._readableState.length !== 0) {
        const chunk = this.read(this._readableState.length);
        websocket._receiver.write(chunk);
      }
      websocket._receiver.end();
      this[kWebSocket] = void 0;
      clearTimeout(websocket._closeTimer);
      if (websocket._receiver._writableState.finished || websocket._receiver._writableState.errorEmitted) {
        websocket.emitClose();
      } else {
        websocket._receiver.on("error", receiverOnFinish);
        websocket._receiver.on("finish", receiverOnFinish);
      }
    }
    function socketOnData(chunk) {
      if (!this[kWebSocket]._receiver.write(chunk)) {
        this.pause();
      }
    }
    function socketOnEnd() {
      const websocket = this[kWebSocket];
      websocket._readyState = WebSocket2.CLOSING;
      websocket._receiver.end();
      this.end();
    }
    function socketOnError() {
      const websocket = this[kWebSocket];
      this.removeListener("error", socketOnError);
      this.on("error", NOOP);
      if (websocket) {
        websocket._readyState = WebSocket2.CLOSING;
        this.destroy();
      }
    }
  }
});

// ../../node_modules/.pnpm/ws@8.22.1/node_modules/ws/lib/stream.js
var require_stream = __commonJS({
  "../../node_modules/.pnpm/ws@8.22.1/node_modules/ws/lib/stream.js"(exports2, module2) {
    "use strict";
    var WebSocket2 = require_websocket();
    var { Duplex } = require("stream");
    function emitClose(stream) {
      stream.emit("close");
    }
    function duplexOnEnd() {
      if (!this.destroyed && this._writableState.finished) {
        this.destroy();
      }
    }
    function duplexOnError(err) {
      this.removeListener("error", duplexOnError);
      this.destroy();
      if (this.listenerCount("error") === 0) {
        this.emit("error", err);
      }
    }
    function createWebSocketStream2(ws, options) {
      let terminateOnDestroy = true;
      const duplex = new Duplex({
        ...options,
        autoDestroy: false,
        emitClose: false,
        objectMode: false,
        writableObjectMode: false
      });
      ws.on("message", function message(msg, isBinary) {
        const data = !isBinary && duplex._readableState.objectMode ? msg.toString() : msg;
        if (!duplex.push(data)) ws.pause();
      });
      ws.once("error", function error(err) {
        if (duplex.destroyed) return;
        terminateOnDestroy = false;
        duplex.destroy(err);
      });
      ws.once("close", function close() {
        if (duplex.destroyed) return;
        duplex.push(null);
      });
      duplex._destroy = function(err, callback) {
        if (ws.readyState === ws.CLOSED) {
          callback(err);
          process.nextTick(emitClose, duplex);
          return;
        }
        let called = false;
        ws.once("error", function error(err2) {
          called = true;
          callback(err2);
        });
        ws.once("close", function close() {
          if (!called) callback(err);
          process.nextTick(emitClose, duplex);
        });
        if (terminateOnDestroy) ws.terminate();
      };
      duplex._final = function(callback) {
        if (ws.readyState === ws.CONNECTING) {
          ws.once("open", function open() {
            duplex._final(callback);
          });
          return;
        }
        if (ws._socket === null) return;
        if (ws._socket._writableState.finished) {
          callback();
          if (duplex._readableState.endEmitted) duplex.destroy();
        } else {
          ws._socket.once("finish", function finish() {
            callback();
          });
          ws.close();
        }
      };
      duplex._read = function() {
        if (ws.isPaused) ws.resume();
      };
      duplex._write = function(chunk, encoding, callback) {
        if (ws.readyState === ws.CONNECTING) {
          ws.once("open", function open() {
            duplex._write(chunk, encoding, callback);
          });
          return;
        }
        ws.send(chunk, callback);
      };
      duplex.on("end", duplexOnEnd);
      duplex.on("error", duplexOnError);
      return duplex;
    }
    module2.exports = createWebSocketStream2;
  }
});

// ../../node_modules/.pnpm/ws@8.22.1/node_modules/ws/lib/subprotocol.js
var require_subprotocol = __commonJS({
  "../../node_modules/.pnpm/ws@8.22.1/node_modules/ws/lib/subprotocol.js"(exports2, module2) {
    "use strict";
    var { tokenChars } = require_validation();
    function parse(header) {
      const protocols = /* @__PURE__ */ new Set();
      let start = -1;
      let end = -1;
      let i = 0;
      for (i; i < header.length; i++) {
        const code = header.charCodeAt(i);
        if (end === -1 && tokenChars[code] === 1) {
          if (start === -1) start = i;
        } else if (i !== 0 && (code === 32 || code === 9)) {
          if (end === -1 && start !== -1) end = i;
        } else if (code === 44) {
          if (start === -1) {
            throw new SyntaxError(`Unexpected character at index ${i}`);
          }
          if (end === -1) end = i;
          const protocol2 = header.slice(start, end);
          if (protocols.has(protocol2)) {
            throw new SyntaxError(`The "${protocol2}" subprotocol is duplicated`);
          }
          protocols.add(protocol2);
          start = end = -1;
        } else {
          throw new SyntaxError(`Unexpected character at index ${i}`);
        }
      }
      if (start === -1 || end !== -1) {
        throw new SyntaxError("Unexpected end of input");
      }
      const protocol = header.slice(start, i);
      if (protocols.has(protocol)) {
        throw new SyntaxError(`The "${protocol}" subprotocol is duplicated`);
      }
      protocols.add(protocol);
      return protocols;
    }
    module2.exports = { parse };
  }
});

// ../../node_modules/.pnpm/ws@8.22.1/node_modules/ws/lib/websocket-server.js
var require_websocket_server = __commonJS({
  "../../node_modules/.pnpm/ws@8.22.1/node_modules/ws/lib/websocket-server.js"(exports2, module2) {
    "use strict";
    var EventEmitter = require("events");
    var http2 = require("http");
    var { Duplex } = require("stream");
    var { createHash } = require("crypto");
    var extension2 = require_extension();
    var PerMessageDeflate2 = require_permessage_deflate();
    var subprotocol2 = require_subprotocol();
    var WebSocket2 = require_websocket();
    var { CLOSE_TIMEOUT, GUID, kWebSocket } = require_constants();
    var keyRegex = /^[+/0-9A-Za-z]{22}==$/;
    var RUNNING = 0;
    var CLOSING = 1;
    var CLOSED = 2;
    var WebSocketServer2 = class extends EventEmitter {
      /**
       * Create a `WebSocketServer` instance.
       *
       * @param {Object} options Configuration options
       * @param {Boolean} [options.allowSynchronousEvents=true] Specifies whether
       *     any of the `'message'`, `'ping'`, and `'pong'` events can be emitted
       *     multiple times in the same tick
       * @param {Boolean} [options.autoPong=true] Specifies whether or not to
       *     automatically send a pong in response to a ping
       * @param {Number} [options.backlog=511] The maximum length of the queue of
       *     pending connections
       * @param {Boolean} [options.clientTracking=true] Specifies whether or not to
       *     track clients
       * @param {Number} [options.closeTimeout=30000] Duration in milliseconds to
       *     wait for the closing handshake to finish after `websocket.close()` is
       *     called
       * @param {Function} [options.handleProtocols] A hook to handle protocols
       * @param {String} [options.host] The hostname where to bind the server
       * @param {Number} [options.maxBufferedChunks=262144] The maximum number of
       *     buffered data chunks
       * @param {Number} [options.maxFragments=16384] The maximum number of message
       *     fragments
       * @param {Number} [options.maxPayload=104857600] The maximum allowed message
       *     size
       * @param {Boolean} [options.noServer=false] Enable no server mode
       * @param {String} [options.path] Accept only connections matching this path
       * @param {(Boolean|Object)} [options.perMessageDeflate=false] Enable/disable
       *     permessage-deflate
       * @param {Number} [options.port] The port where to bind the server
       * @param {(http.Server|https.Server)} [options.server] A pre-created HTTP/S
       *     server to use
       * @param {Boolean} [options.skipUTF8Validation=false] Specifies whether or
       *     not to skip UTF-8 validation for text and close messages
       * @param {Function} [options.verifyClient] A hook to reject connections
       * @param {Function} [options.WebSocket=WebSocket] Specifies the `WebSocket`
       *     class to use. It must be the `WebSocket` class or class that extends it
       * @param {Function} [callback] A listener for the `listening` event
       */
      constructor(options, callback) {
        super();
        options = {
          allowSynchronousEvents: true,
          autoPong: true,
          maxBufferedChunks: 256 * 1024,
          maxFragments: 16 * 1024,
          maxPayload: 100 * 1024 * 1024,
          skipUTF8Validation: false,
          perMessageDeflate: false,
          handleProtocols: null,
          clientTracking: true,
          closeTimeout: CLOSE_TIMEOUT,
          verifyClient: null,
          noServer: false,
          backlog: null,
          // use default (511 as implemented in net.js)
          server: null,
          host: null,
          path: null,
          port: null,
          WebSocket: WebSocket2,
          ...options
        };
        if (options.port == null && !options.server && !options.noServer || options.port != null && (options.server || options.noServer) || options.server && options.noServer) {
          throw new TypeError(
            'One and only one of the "port", "server", or "noServer" options must be specified'
          );
        }
        if (options.port != null) {
          this._server = http2.createServer((req, res) => {
            const body = http2.STATUS_CODES[426];
            res.writeHead(426, {
              "Content-Length": body.length,
              "Content-Type": "text/plain"
            });
            res.end(body);
          });
          this._server.listen(
            options.port,
            options.host,
            options.backlog,
            callback
          );
        } else if (options.server) {
          this._server = options.server;
        }
        if (this._server) {
          const emitConnection = this.emit.bind(this, "connection");
          this._removeListeners = addListeners(this._server, {
            listening: this.emit.bind(this, "listening"),
            error: this.emit.bind(this, "error"),
            upgrade: (req, socket, head) => {
              this.handleUpgrade(req, socket, head, emitConnection);
            }
          });
        }
        if (options.perMessageDeflate === true) options.perMessageDeflate = {};
        if (options.clientTracking) {
          this.clients = /* @__PURE__ */ new Set();
          this._shouldEmitClose = false;
        }
        this.options = options;
        this._state = RUNNING;
      }
      /**
       * Returns the bound address, the address family name, and port of the server
       * as reported by the operating system if listening on an IP socket.
       * If the server is listening on a pipe or UNIX domain socket, the name is
       * returned as a string.
       *
       * @return {(Object|String|null)} The address of the server
       * @public
       */
      address() {
        if (this.options.noServer) {
          throw new Error('The server is operating in "noServer" mode');
        }
        if (!this._server) return null;
        return this._server.address();
      }
      /**
       * Stop the server from accepting new connections and emit the `'close'` event
       * when all existing connections are closed.
       *
       * @param {Function} [cb] A one-time listener for the `'close'` event
       * @public
       */
      close(cb) {
        if (this._state === CLOSED) {
          if (cb) {
            this.once("close", () => {
              cb(new Error("The server is not running"));
            });
          }
          process.nextTick(emitClose, this);
          return;
        }
        if (cb) this.once("close", cb);
        if (this._state === CLOSING) return;
        this._state = CLOSING;
        if (this.options.noServer || this.options.server) {
          if (this._server) {
            this._removeListeners();
            this._removeListeners = this._server = null;
          }
          if (this.clients) {
            if (!this.clients.size) {
              process.nextTick(emitClose, this);
            } else {
              this._shouldEmitClose = true;
            }
          } else {
            process.nextTick(emitClose, this);
          }
        } else {
          const server = this._server;
          this._removeListeners();
          this._removeListeners = this._server = null;
          server.close(() => {
            emitClose(this);
          });
        }
      }
      /**
       * See if a given request should be handled by this server instance.
       *
       * @param {http.IncomingMessage} req Request object to inspect
       * @return {Boolean} `true` if the request is valid, else `false`
       * @public
       */
      shouldHandle(req) {
        if (this.options.path) {
          const index = req.url.indexOf("?");
          const pathname = index !== -1 ? req.url.slice(0, index) : req.url;
          if (pathname !== this.options.path) return false;
        }
        return true;
      }
      /**
       * Handle a HTTP Upgrade request.
       *
       * @param {http.IncomingMessage} req The request object
       * @param {Duplex} socket The network socket between the server and client
       * @param {Buffer} head The first packet of the upgraded stream
       * @param {Function} cb Callback
       * @public
       */
      handleUpgrade(req, socket, head, cb) {
        socket.on("error", socketOnError);
        const key = req.headers["sec-websocket-key"];
        const upgrade = req.headers.upgrade;
        const version = +req.headers["sec-websocket-version"];
        if (req.method !== "GET") {
          const message = "Invalid HTTP method";
          abortHandshakeOrEmitwsClientError(this, req, socket, 405, message);
          return;
        }
        if (upgrade === void 0 || upgrade.toLowerCase() !== "websocket") {
          const message = "Invalid Upgrade header";
          abortHandshakeOrEmitwsClientError(this, req, socket, 400, message);
          return;
        }
        if (key === void 0 || !keyRegex.test(key)) {
          const message = "Missing or invalid Sec-WebSocket-Key header";
          abortHandshakeOrEmitwsClientError(this, req, socket, 400, message);
          return;
        }
        if (version !== 13 && version !== 8) {
          const message = "Missing or invalid Sec-WebSocket-Version header";
          abortHandshakeOrEmitwsClientError(this, req, socket, 400, message, {
            "Sec-WebSocket-Version": "13, 8"
          });
          return;
        }
        if (!this.shouldHandle(req)) {
          abortHandshake(socket, 400);
          return;
        }
        const secWebSocketProtocol = req.headers["sec-websocket-protocol"];
        let protocols = /* @__PURE__ */ new Set();
        if (secWebSocketProtocol !== void 0) {
          try {
            protocols = subprotocol2.parse(secWebSocketProtocol);
          } catch (err) {
            const message = "Invalid Sec-WebSocket-Protocol header";
            abortHandshakeOrEmitwsClientError(this, req, socket, 400, message);
            return;
          }
        }
        const secWebSocketExtensions = req.headers["sec-websocket-extensions"];
        const extensions = {};
        if (this.options.perMessageDeflate && secWebSocketExtensions !== void 0) {
          const perMessageDeflate = new PerMessageDeflate2({
            ...this.options.perMessageDeflate,
            isServer: true,
            maxPayload: this.options.maxPayload
          });
          try {
            const offers = extension2.parse(secWebSocketExtensions);
            if (offers[PerMessageDeflate2.extensionName]) {
              perMessageDeflate.accept(offers[PerMessageDeflate2.extensionName]);
              extensions[PerMessageDeflate2.extensionName] = perMessageDeflate;
            }
          } catch (err) {
            const message = "Invalid or unacceptable Sec-WebSocket-Extensions header";
            abortHandshakeOrEmitwsClientError(this, req, socket, 400, message);
            return;
          }
        }
        if (this.options.verifyClient) {
          const info = {
            origin: req.headers[`${version === 8 ? "sec-websocket-origin" : "origin"}`],
            secure: !!(req.socket.authorized || req.socket.encrypted),
            req
          };
          if (this.options.verifyClient.length === 2) {
            this.options.verifyClient(info, (verified, code, message, headers) => {
              if (!verified) {
                return abortHandshake(socket, code || 401, message, headers);
              }
              this.completeUpgrade(
                extensions,
                key,
                protocols,
                req,
                socket,
                head,
                cb
              );
            });
            return;
          }
          if (!this.options.verifyClient(info)) return abortHandshake(socket, 401);
        }
        this.completeUpgrade(extensions, key, protocols, req, socket, head, cb);
      }
      /**
       * Upgrade the connection to WebSocket.
       *
       * @param {Object} extensions The accepted extensions
       * @param {String} key The value of the `Sec-WebSocket-Key` header
       * @param {Set} protocols The subprotocols
       * @param {http.IncomingMessage} req The request object
       * @param {Duplex} socket The network socket between the server and client
       * @param {Buffer} head The first packet of the upgraded stream
       * @param {Function} cb Callback
       * @throws {Error} If called more than once with the same socket
       * @private
       */
      completeUpgrade(extensions, key, protocols, req, socket, head, cb) {
        if (!socket.readable || !socket.writable) return socket.destroy();
        if (socket[kWebSocket]) {
          throw new Error(
            "server.handleUpgrade() was called more than once with the same socket, possibly due to a misconfiguration"
          );
        }
        if (this._state > RUNNING) return abortHandshake(socket, 503);
        const digest = createHash("sha1").update(key + GUID).digest("base64");
        const headers = [
          "HTTP/1.1 101 Switching Protocols",
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Accept: ${digest}`
        ];
        const ws = new this.options.WebSocket(null, void 0, this.options);
        if (protocols.size) {
          const protocol = this.options.handleProtocols ? this.options.handleProtocols(protocols, req) : protocols.values().next().value;
          if (protocol) {
            headers.push(`Sec-WebSocket-Protocol: ${protocol}`);
            ws._protocol = protocol;
          }
        }
        if (extensions[PerMessageDeflate2.extensionName]) {
          const params = extensions[PerMessageDeflate2.extensionName].params;
          const value = extension2.format({
            [PerMessageDeflate2.extensionName]: [params]
          });
          headers.push(`Sec-WebSocket-Extensions: ${value}`);
          ws._extensions = extensions;
        }
        this.emit("headers", headers, req);
        socket.write(headers.concat("\r\n").join("\r\n"));
        socket.removeListener("error", socketOnError);
        ws.setSocket(socket, head, {
          allowSynchronousEvents: this.options.allowSynchronousEvents,
          maxBufferedChunks: this.options.maxBufferedChunks,
          maxFragments: this.options.maxFragments,
          maxPayload: this.options.maxPayload,
          skipUTF8Validation: this.options.skipUTF8Validation
        });
        if (this.clients) {
          this.clients.add(ws);
          ws.on("close", () => {
            this.clients.delete(ws);
            if (this._shouldEmitClose && !this.clients.size) {
              process.nextTick(emitClose, this);
            }
          });
        }
        cb(ws, req);
      }
    };
    module2.exports = WebSocketServer2;
    function addListeners(server, map) {
      for (const event of Object.keys(map)) server.on(event, map[event]);
      return function removeListeners() {
        for (const event of Object.keys(map)) {
          server.removeListener(event, map[event]);
        }
      };
    }
    function emitClose(server) {
      server._state = CLOSED;
      server.emit("close");
    }
    function socketOnError() {
      this.destroy();
    }
    function abortHandshake(socket, code, message, headers) {
      message = message || http2.STATUS_CODES[code];
      headers = {
        Connection: "close",
        "Content-Type": "text/html",
        "Content-Length": Buffer.byteLength(message),
        ...headers
      };
      socket.once("finish", socket.destroy);
      socket.end(
        `HTTP/1.1 ${code} ${http2.STATUS_CODES[code]}\r
` + Object.keys(headers).map((h) => `${h}: ${headers[h]}`).join("\r\n") + "\r\n\r\n" + message
      );
    }
    function abortHandshakeOrEmitwsClientError(server, req, socket, code, message, headers) {
      if (server.listenerCount("wsClientError")) {
        const err = new Error(message);
        Error.captureStackTrace(err, abortHandshakeOrEmitwsClientError);
        server.emit("wsClientError", err, socket, req);
      } else {
        abortHandshake(socket, code, message, headers);
      }
    }
  }
});

// src/server.ts
var import_node_http = __toESM(require("node:http"), 1);
var import_node_fs = __toESM(require("node:fs"), 1);
var import_node_path = __toESM(require("node:path"), 1);

// ../../node_modules/.pnpm/ws@8.22.1/node_modules/ws/wrapper.mjs
var import_stream = __toESM(require_stream(), 1);
var import_extension = __toESM(require_extension(), 1);
var import_permessage_deflate = __toESM(require_permessage_deflate(), 1);
var import_receiver = __toESM(require_receiver(), 1);
var import_sender = __toESM(require_sender(), 1);
var import_subprotocol = __toESM(require_subprotocol(), 1);
var import_websocket = __toESM(require_websocket(), 1);
var import_websocket_server = __toESM(require_websocket_server(), 1);

// ../../packages/engine/src/types.ts
var RESOURCES = ["wood", "brick", "sheep", "wheat", "ore"];
var TERRAINS = [...RESOURCES, "desert"];
var PLAYER_COLORS = ["red", "blue", "white", "orange"];
function emptyResources() {
  return { wood: 0, brick: 0, sheep: 0, wheat: 0, ore: 0 };
}

// ../../packages/engine/src/board.ts
var HEX_SIZE = 56;
var SQRT3 = Math.sqrt(3);
var PRECISION = 100;
function cornersOf(cx, cy, size = HEX_SIZE) {
  const out = [];
  for (let i = 0; i < 6; i++) {
    const ang = Math.PI / 180 * (60 * i - 30);
    out.push({ x: cx + size * Math.cos(ang), y: cy + size * Math.sin(ang) });
  }
  return out;
}
function vertexKey(x, y) {
  return `${Math.round(x * PRECISION)},${Math.round(y * PRECISION)}`;
}
function edgeKey(a, b) {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}
function buildGeometry(rows) {
  const center = (rows.length - 1) / 2;
  const tiles = {};
  const tileKeys = [];
  rows.forEach((count, row) => {
    const u0 = 1 - count;
    for (let i = 0; i < count; i++) {
      const u = u0 + i * 2;
      const key = `${u},${row}`;
      tiles[key] = {
        key,
        u,
        row,
        x: HEX_SIZE * SQRT3 * u / 2,
        y: HEX_SIZE * 1.5 * (row - center)
      };
      tileKeys.push(key);
    }
  });
  const vertices = {};
  const vertexKeys = [];
  const edges = {};
  const edgeKeys = [];
  const ensureVertex = (x, y) => {
    const k = vertexKey(x, y);
    let v = vertices[k];
    if (!v) {
      v = { key: k, x, y, tiles: [], edges: [], neighbors: [] };
      vertices[k] = v;
      vertexKeys.push(k);
    }
    return k;
  };
  for (const tileKey of tileKeys) {
    const t = tiles[tileKey];
    const pts = cornersOf(t.x, t.y);
    const vks = pts.map((p) => ensureVertex(p.x, p.y));
    for (const vk of vks) {
      const v = vertices[vk];
      if (!v.tiles.includes(tileKey)) v.tiles.push(tileKey);
    }
    for (let i = 0; i < 6; i++) {
      const a = vks[i];
      const b = vks[(i + 1) % 6];
      const ek = edgeKey(a, b);
      let e = edges[ek];
      if (!e) {
        e = { key: ek, a, b, tiles: [] };
        edges[ek] = e;
        edgeKeys.push(ek);
      }
      if (!e.tiles.includes(tileKey)) e.tiles.push(tileKey);
      const va = vertices[a];
      const vb = vertices[b];
      if (!va.edges.includes(ek)) va.edges.push(ek);
      if (!vb.edges.includes(ek)) vb.edges.push(ek);
      if (!va.neighbors.includes(b)) va.neighbors.push(b);
      if (!vb.neighbors.includes(a)) vb.neighbors.push(a);
    }
  }
  return { tiles, tileKeys, vertices, vertexKeys, edges, edgeKeys };
}
function boundaryEdges(geo) {
  return geo.edgeKeys.filter((k) => geo.edges[k].tiles.length === 1);
}
function tileVertexKeys(geo, tileKey) {
  const t = geo.tiles[tileKey];
  if (!t) return [];
  return cornersOf(t.x, t.y).map((p) => vertexKey(p.x, p.y));
}
var MAP_4P = {
  id: "base-4p",
  label: "4 \u4EBA \xB7 19 \u683C",
  rows: [3, 4, 5, 4, 3],
  tiles: {
    "-2,0": { terrain: "sheep", number: 3 },
    "0,0": { terrain: "ore", number: 10 },
    "2,0": { terrain: "wood", number: 2 },
    "-3,1": { terrain: "brick", number: 9 },
    "-1,1": { terrain: "wheat", number: 12 },
    "1,1": { terrain: "wheat", number: 6 },
    "3,1": { terrain: "sheep", number: 4 },
    "-4,2": { terrain: "wood", number: 5 },
    "-2,2": { terrain: "ore", number: 11 },
    "0,2": { terrain: "desert", number: null },
    "2,2": { terrain: "brick", number: 5 },
    "4,2": { terrain: "sheep", number: 9 },
    "-3,3": { terrain: "wood", number: 8 },
    "-1,3": { terrain: "wheat", number: 10 },
    "1,3": { terrain: "brick", number: 8 },
    "3,3": { terrain: "ore", number: 4 },
    "-2,4": { terrain: "sheep", number: 11 },
    "0,4": { terrain: "wood", number: 6 },
    "2,4": { terrain: "wheat", number: 3 }
  }
};

// ../../packages/engine/src/state.ts
var PORT_PATTERN = [
  { kind: "generic" },
  { kind: "specific", resource: "wood" },
  { kind: "generic" },
  { kind: "specific", resource: "brick" },
  { kind: "generic" },
  { kind: "specific", resource: "sheep" },
  { kind: "generic" },
  { kind: "specific", resource: "wheat" },
  { kind: "specific", resource: "ore" }
];
function computePorts(geo, count = 9) {
  const boundary = boundaryEdges(geo);
  const withAngle = boundary.map((ek) => {
    const e = geo.edges[ek];
    const va = geo.vertices[e.a];
    const vb = geo.vertices[e.b];
    const mx = (va.x + vb.x) / 2;
    const my = (va.y + vb.y) / 2;
    return { ek, angle: Math.atan2(my, mx) };
  });
  withAngle.sort((p, q) => p.angle - q.angle);
  const slots = [];
  for (let k = 0; k < count; k++) {
    const pick = withAngle[Math.round(k * withAngle.length / count) % withAngle.length];
    slots.push({ edge: pick.ek, port: PORT_PATTERN[k % PORT_PATTERN.length] });
  }
  return slots;
}
function buildBoard(spec) {
  return { spec, geo: buildGeometry(spec.rows) };
}
function createGame(board, playerNames, colors, setupGrant = true) {
  const { geo, spec } = board;
  const tiles = {};
  for (const tk of geo.tileKeys) {
    const def = spec.tiles[tk];
    if (!def) throw new Error(`\u5730\u56FE\u7F3A\u5C11\u5730\u5757\u5B9A\u4E49: ${tk}`);
    tiles[tk] = { key: tk, terrain: def.terrain, number: def.number };
  }
  const desert = geo.tileKeys.find((tk) => tiles[tk].terrain === "desert");
  return {
    mapId: spec.id,
    tiles,
    ports: computePorts(geo),
    buildings: {},
    roads: {},
    robberTile: desert ?? geo.tileKeys[0],
    players: playerNames.map((name, i) => ({
      index: i,
      name,
      color: colors[i] ?? "red",
      resources: emptyResources(),
      devCards: [],
      playedKnights: 0,
      devPlayedThisTurn: false
    })),
    current: 0,
    phase: "setup",
    hasRolled: false,
    dice: null,
    devDeck: shuffle(makeDevDeck()),
    turn: 1,
    setup: { step: 0, seat: 0 },
    winner: null,
    longestRoad: null,
    largestArmy: null,
    pendingDiscards: {},
    pendingRobber: false,
    setupGrant
  };
}
function shuffle(input) {
  const arr = input.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr;
}
function makeDevDeck() {
  const deck = [];
  for (let i = 0; i < 14; i++) deck.push("knight");
  for (let i = 0; i < 5; i++) deck.push("victory");
  for (let i = 0; i < 2; i++) deck.push("monopoly");
  for (let i = 0; i < 2; i++) deck.push("plenty");
  for (let i = 0; i < 2; i++) deck.push("roadbuilding");
  return deck;
}
function setupSeatOrder(playerCount) {
  const forward = Array.from({ length: playerCount }, (_, i) => i);
  return [...forward, ...forward.slice().reverse()];
}
function handSize(player) {
  return RESOURCES.reduce((sum, r) => sum + player.resources[r], 0);
}
function discardCount(hand) {
  if (hand < 8) return 0;
  return Math.ceil(hand / 2);
}
function countBuildings(state, player) {
  let villages = 0;
  let cities = 0;
  for (const b of Object.values(state.buildings)) {
    if (b.owner !== player) continue;
    if (b.city) cities++;
    else villages++;
  }
  let roads = 0;
  for (const owner of Object.values(state.roads)) {
    if (owner === player) roads++;
  }
  return { villages, cities, roads };
}

// ../../packages/engine/src/rules/setup.ts
function placeSettlement(board, state, cmd) {
  if (state.phase !== "setup" || !state.setup) {
    return { ok: false, reason: "WRONG_PHASE" };
  }
  if (cmd.seat !== state.setup.seat) {
    return { ok: false, reason: "NOT_YOUR_TURN" };
  }
  const { geo } = board;
  const vertex = geo.vertices[cmd.vertex];
  if (!vertex) return { ok: false, reason: "UNKNOWN_VERTEX" };
  if (state.buildings[cmd.vertex]) return { ok: false, reason: "OCCUPIED" };
  for (const nb of vertex.neighbors) {
    if (state.buildings[nb]) return { ok: false, reason: "TOO_CLOSE", detail: nb };
  }
  const edge = geo.edges[cmd.edge];
  if (!edge) return { ok: false, reason: "UNKNOWN_EDGE" };
  if (edge.a !== cmd.vertex && edge.b !== cmd.vertex) {
    return { ok: false, reason: "EDGE_NOT_ADJACENT" };
  }
  if (state.roads[cmd.edge] !== void 0) return { ok: false, reason: "EDGE_TAKEN" };
  const next = structuredClone(state);
  const order = setupSeatOrder(next.players.length);
  const round = next.setup.step < next.players.length ? 1 : 2;
  next.buildings[cmd.vertex] = { owner: cmd.seat, city: false };
  next.roads[cmd.edge] = cmd.seat;
  const events = [
    { type: "SETUP_PLACED", player: cmd.seat, vertex: cmd.vertex, edge: cmd.edge, round }
  ];
  if (round === 2 && state.setupGrant) {
    const gains = {};
    for (const tileKey of vertex.tiles) {
      const tile = next.tiles[tileKey];
      if (tile.terrain === "desert") continue;
      if (tileKey === next.robberTile) continue;
      const res = tile.terrain;
      gains[res] = (gains[res] ?? 0) + 1;
      next.players[cmd.seat].resources[res] += 1;
    }
    if (Object.keys(gains).length > 0) {
      events.push({ type: "RESOURCES_GAINED", player: cmd.seat, resources: gains });
    }
  }
  next.setup.step += 1;
  if (next.setup.step >= order.length) {
    next.phase = "play";
    next.setup = null;
    next.current = 0;
    next.hasRolled = false;
    events.push({ type: "SETUP_COMPLETED", firstPlayer: 0 });
    events.push({ type: "TURN_BEGUN", player: 0, turn: next.turn });
  } else {
    next.setup.seat = order[next.setup.step];
  }
  return { ok: true, state: next, events };
}

// ../../packages/engine/src/rules/build.ts
var COSTS = {
  road: { wood: 1, brick: 1 },
  settlement: { wood: 1, brick: 1, sheep: 1, wheat: 1 },
  city: { ore: 3, wheat: 2 }
};
var LIMITS = { road: 15, settlement: 5, city: 4 };
function guard(state, seat) {
  if (state.phase !== "play") return { ok: false, reason: "WRONG_PHASE" };
  if (seat !== state.current) return { ok: false, reason: "NOT_YOUR_TURN" };
  return null;
}
function canAfford(player, cost) {
  for (const key of Object.keys(cost)) {
    if (player.resources[key] < (cost[key] ?? 0)) return false;
  }
  return true;
}
function spend(player, cost) {
  const spent = {};
  for (const key of Object.keys(cost)) {
    const amount = cost[key] ?? 0;
    player.resources[key] -= amount;
    if (amount > 0) spent[key] = amount;
  }
  return spent;
}
function roadConnected(board, state, edgeKey2, player) {
  const { geo } = board;
  const edge = geo.edges[edgeKey2];
  if (!edge) return false;
  for (const vk of [edge.a, edge.b]) {
    const building = state.buildings[vk];
    if (building && building.owner === player) return true;
    const vertex = geo.vertices[vk];
    if (!vertex) continue;
    for (const ek of vertex.edges) {
      if (ek !== edgeKey2 && state.roads[ek] === player) return true;
    }
  }
  return false;
}
function settlementConnected(board, state, vertexKey2, player) {
  const vertex = board.geo.vertices[vertexKey2];
  if (!vertex) return false;
  return vertex.edges.some((ek) => state.roads[ek] === player);
}
function buildRoad(board, state, cmd) {
  const bad = guard(state, cmd.seat);
  if (bad) return bad;
  const edge = board.geo.edges[cmd.edge];
  if (!edge) return { ok: false, reason: "UNKNOWN_EDGE" };
  if (state.roads[cmd.edge] !== void 0) return { ok: false, reason: "EDGE_TAKEN" };
  const counts = countBuildings(state, cmd.seat);
  if (counts.roads >= LIMITS.road) return { ok: false, reason: "BUILD_LIMIT" };
  const player = state.players[cmd.seat];
  if (!canAfford(player, COSTS.road)) return { ok: false, reason: "INSUFFICIENT_RESOURCES" };
  if (!roadConnected(board, state, cmd.edge, cmd.seat)) {
    return { ok: false, reason: "NOT_CONNECTED" };
  }
  const next = structuredClone(state);
  const spent = spend(next.players[cmd.seat], COSTS.road);
  next.roads[cmd.edge] = cmd.seat;
  const events = [
    { type: "RESOURCES_SPENT", player: cmd.seat, resources: spent },
    { type: "ROAD_BUILT", player: cmd.seat, edge: cmd.edge }
  ];
  return { ok: true, state: next, events };
}
function buildSettlement(board, state, cmd) {
  const bad = guard(state, cmd.seat);
  if (bad) return bad;
  const vertex = board.geo.vertices[cmd.vertex];
  if (!vertex) return { ok: false, reason: "UNKNOWN_VERTEX" };
  if (state.buildings[cmd.vertex]) return { ok: false, reason: "OCCUPIED" };
  for (const nb of vertex.neighbors) {
    if (state.buildings[nb]) return { ok: false, reason: "TOO_CLOSE", detail: nb };
  }
  const counts = countBuildings(state, cmd.seat);
  if (counts.villages + counts.cities >= LIMITS.settlement) {
    return { ok: false, reason: "BUILD_LIMIT" };
  }
  const player = state.players[cmd.seat];
  if (!canAfford(player, COSTS.settlement)) {
    return { ok: false, reason: "INSUFFICIENT_RESOURCES" };
  }
  if (!settlementConnected(board, state, cmd.vertex, cmd.seat)) {
    return { ok: false, reason: "NOT_CONNECTED" };
  }
  const next = structuredClone(state);
  const spent = spend(next.players[cmd.seat], COSTS.settlement);
  next.buildings[cmd.vertex] = { owner: cmd.seat, city: false };
  const events = [
    { type: "RESOURCES_SPENT", player: cmd.seat, resources: spent },
    { type: "SETTLEMENT_BUILT", player: cmd.seat, vertex: cmd.vertex }
  ];
  return { ok: true, state: next, events };
}
function buildCity(board, state, cmd) {
  const bad = guard(state, cmd.seat);
  if (bad) return bad;
  const vertex = board.geo.vertices[cmd.vertex];
  if (!vertex) return { ok: false, reason: "UNKNOWN_VERTEX" };
  const existing = state.buildings[cmd.vertex];
  if (!existing) return { ok: false, reason: "NOT_A_VILLAGE" };
  if (existing.owner !== cmd.seat) return { ok: false, reason: "NOT_YOUR_BUILDING" };
  if (existing.city) return { ok: false, reason: "NOT_A_VILLAGE" };
  const counts = countBuildings(state, cmd.seat);
  if (counts.cities >= LIMITS.city) return { ok: false, reason: "BUILD_LIMIT" };
  const player = state.players[cmd.seat];
  if (!canAfford(player, COSTS.city)) return { ok: false, reason: "INSUFFICIENT_RESOURCES" };
  const next = structuredClone(state);
  const spent = spend(next.players[cmd.seat], COSTS.city);
  next.buildings[cmd.vertex].city = true;
  const events = [
    { type: "RESOURCES_SPENT", player: cmd.seat, resources: spent },
    { type: "CITY_BUILT", player: cmd.seat, vertex: cmd.vertex }
  ];
  return { ok: true, state: next, events };
}

// ../../packages/engine/src/rules/roll.ts
function randomDice() {
  const d = () => 1 + Math.floor(Math.random() * 6);
  return [d(), d()];
}
function rollDice(board, state, cmd) {
  if (state.phase !== "play") return { ok: false, reason: "WRONG_PHASE" };
  if (cmd.seat !== state.current) return { ok: false, reason: "NOT_YOUR_TURN" };
  if (state.hasRolled) return { ok: false, reason: "ALREADY_ROLLED" };
  const dice = cmd.dice ?? randomDice();
  if (dice[0] < 1 || dice[0] > 6 || dice[1] < 1 || dice[1] > 6) {
    return { ok: false, reason: "BAD_DICE" };
  }
  const next = structuredClone(state);
  const [d1, d2] = dice;
  const sum = d1 + d2;
  next.hasRolled = true;
  next.dice = [d1, d2];
  const events = [{ type: "DICE_ROLLED", player: cmd.seat, dice: [d1, d2], sum }];
  if (sum === 7) {
    const requirements = [];
    const pending = {};
    for (const p of next.players) {
      const count = discardCount(handSize(p));
      if (count > 0) {
        pending[p.index] = count;
        requirements.push({ player: p.index, count });
      }
    }
    next.pendingDiscards = pending;
    next.pendingRobber = true;
    events.push({ type: "SEVEN_ROLLED", player: cmd.seat });
    if (requirements.length > 0) {
      events.push({ type: "DISCARD_REQUIRED", requirements });
    }
    return { ok: true, state: next, events };
  }
  const grants = /* @__PURE__ */ new Map();
  for (const vertexKey2 of Object.keys(next.buildings)) {
    const building = next.buildings[vertexKey2];
    const vertex = board.geo.vertices[vertexKey2];
    if (!vertex) continue;
    for (const tileKey of vertex.tiles) {
      const tile = next.tiles[tileKey];
      if (tile.number !== sum) continue;
      if (tileKey === next.robberTile) continue;
      const res = tile.terrain;
      const amount = building.city ? 2 : 1;
      const player = next.players[building.owner];
      player.resources[res] += amount;
      const g = grants.get(building.owner) ?? {};
      g[res] = (g[res] ?? 0) + amount;
      grants.set(building.owner, g);
    }
  }
  for (const [owner, resources] of grants) {
    events.push({ type: "RESOURCES_GAINED", player: owner, resources });
  }
  return { ok: true, state: next, events };
}
function discardCards(board, state, cmd) {
  if (state.phase !== "play") return { ok: false, reason: "WRONG_PHASE" };
  const need = state.pendingDiscards[cmd.seat];
  if (need === void 0) return { ok: false, reason: "NOTHING_TO_DISCARD" };
  let given = 0;
  for (const r of RESOURCES) given += cmd.resources[r] ?? 0;
  if (given !== need) {
    return { ok: false, reason: "WRONG_DISCARD_COUNT", detail: `\u9700\u8981 ${need} \u5F20\uFF0C\u63D0\u4EA4\u4E86 ${given} \u5F20` };
  }
  const player = state.players[cmd.seat];
  if (!player) return { ok: false, reason: "INVALID_TARGET" };
  if (!canAfford(player, cmd.resources)) return { ok: false, reason: "INSUFFICIENT_RESOURCES" };
  const next = structuredClone(state);
  const p = next.players[cmd.seat];
  for (const r of RESOURCES) p.resources[r] -= cmd.resources[r] ?? 0;
  delete next.pendingDiscards[cmd.seat];
  return {
    ok: true,
    state: next,
    events: [{ type: "CARDS_DISCARDED", player: cmd.seat, count: given }]
  };
}
function endTurn(state, seat) {
  if (state.phase !== "play") return { ok: false, reason: "WRONG_PHASE" };
  if (seat !== state.current) return { ok: false, reason: "NOT_YOUR_TURN" };
  if (!state.hasRolled) return { ok: false, reason: "NOT_YET_ROLLED" };
  const next = structuredClone(state);
  const ending = next.current;
  next.current = (next.current + 1) % next.players.length;
  next.hasRolled = false;
  next.dice = null;
  next.turn += 1;
  for (const p of next.players) {
    p.devPlayedThisTurn = false;
    for (const entry of p.devCards) entry.playable = true;
  }
  return {
    ok: true,
    state: next,
    events: [
      { type: "TURN_ENDED", player: ending },
      { type: "TURN_BEGUN", player: next.current, turn: next.turn }
    ]
  };
}

// ../../packages/engine/src/rules/dev.ts
var DEV_COST = { sheep: 1, wheat: 1, ore: 1 };
function guard2(state, seat) {
  if (state.phase !== "play") return { ok: false, reason: "WRONG_PHASE" };
  if (seat !== state.current) return { ok: false, reason: "NOT_YOUR_TURN" };
  return null;
}
function findPlayable(player, card) {
  return player.devCards.findIndex((e) => e.card === card && e.playable);
}
function assertCanPlay(state, seat, card) {
  const player = state.players[seat];
  if (player.devPlayedThisTurn) return { ok: false, reason: "DEV_ALREADY_PLAYED" };
  if (findPlayable(player, card) < 0) return { ok: false, reason: "CARD_NOT_AVAILABLE" };
  return null;
}
function stealRandom(victim) {
  const pool = [];
  for (const r of RESOURCES) {
    for (let i = 0; i < victim.resources[r]; i++) pool.push(r);
  }
  if (pool.length === 0) return null;
  return pool[Math.floor(Math.random() * pool.length)];
}
function hasBuildingAdjacent(board, state, tileKey, player) {
  for (const vk of tileVertexKeys(board.geo, tileKey)) {
    const b = state.buildings[vk];
    if (b && b.owner === player) return true;
  }
  return false;
}
function buyDevCard(board, state, cmd) {
  const bad = guard2(state, cmd.seat);
  if (bad) return bad;
  if (state.devDeck.length === 0) return { ok: false, reason: "DECK_EMPTY" };
  const player = state.players[cmd.seat];
  if (!canAfford(player, DEV_COST)) return { ok: false, reason: "INSUFFICIENT_RESOURCES" };
  const next = structuredClone(state);
  const card = next.devDeck.shift();
  const spent = spend(next.players[cmd.seat], DEV_COST);
  next.players[cmd.seat].devCards.push({ card, playable: false });
  const events = [
    { type: "RESOURCES_SPENT", player: cmd.seat, resources: spent },
    { type: "DEV_CARD_BOUGHT", player: cmd.seat, count: 1 }
  ];
  return { ok: true, state: next, events };
}
function playKnight(board, state, cmd) {
  const bad = guard2(state, cmd.seat);
  if (bad) return bad;
  const early = assertCanPlay(state, cmd.seat, "knight");
  if (early) return early;
  if (!board.geo.tiles[cmd.tile]) return { ok: false, reason: "UNKNOWN_TILE" };
  if (cmd.tile === state.robberTile) return { ok: false, reason: "ROBBER_SAME_TILE" };
  const next = structuredClone(state);
  const player = next.players[cmd.seat];
  const from = next.robberTile;
  next.robberTile = cmd.tile;
  player.devCards.splice(findPlayable(player, "knight"), 1);
  player.playedKnights += 1;
  player.devPlayedThisTurn = true;
  const events = [
    { type: "DEV_CARD_PLAYED", player: cmd.seat, card: "knight" },
    { type: "ROBBER_MOVED", player: cmd.seat, from, to: cmd.tile }
  ];
  if (cmd.stealFrom !== void 0 && cmd.stealFrom !== cmd.seat) {
    const victim = next.players[cmd.stealFrom];
    if (victim && hasBuildingAdjacent(board, next, cmd.tile, cmd.stealFrom)) {
      const gained = stealRandom(victim);
      if (gained) {
        victim.resources[gained] -= 1;
        player.resources[gained] += 1;
        events.push({ type: "CARD_STOLEN", thief: cmd.seat, victim: cmd.stealFrom });
      }
    }
  }
  return { ok: true, state: next, events };
}
function playMonopoly(board, state, cmd) {
  const bad = guard2(state, cmd.seat);
  if (bad) return bad;
  const early = assertCanPlay(state, cmd.seat, "monopoly");
  if (early) return early;
  const next = structuredClone(state);
  const player = next.players[cmd.seat];
  player.devCards.splice(findPlayable(player, "monopoly"), 1);
  player.devPlayedThisTurn = true;
  const gains = [];
  for (const other of next.players) {
    if (other.index === cmd.seat) continue;
    const amount = other.resources[cmd.resource];
    if (amount <= 0) continue;
    other.resources[cmd.resource] = 0;
    player.resources[cmd.resource] += amount;
    gains.push({ player: other.index, amount });
  }
  const events = [
    { type: "DEV_CARD_PLAYED", player: cmd.seat, card: "monopoly" },
    { type: "MONOPOLY_RESOLVED", player: cmd.seat, resource: cmd.resource, gains }
  ];
  return { ok: true, state: next, events };
}
function playPlenty(board, state, cmd) {
  const bad = guard2(state, cmd.seat);
  if (bad) return bad;
  const early = assertCanPlay(state, cmd.seat, "plenty");
  if (early) return early;
  const next = structuredClone(state);
  const player = next.players[cmd.seat];
  player.devCards.splice(findPlayable(player, "plenty"), 1);
  player.devPlayedThisTurn = true;
  const gained = {};
  for (const r of cmd.resources) {
    player.resources[r] += 1;
    gained[r] = (gained[r] ?? 0) + 1;
  }
  const events = [
    { type: "DEV_CARD_PLAYED", player: cmd.seat, card: "plenty" },
    { type: "RESOURCES_GAINED", player: cmd.seat, resources: gained }
  ];
  return { ok: true, state: next, events };
}
function playRoadBuilding(board, state, cmd) {
  const bad = guard2(state, cmd.seat);
  if (bad) return bad;
  const early = assertCanPlay(state, cmd.seat, "roadbuilding");
  if (early) return early;
  const wanted = cmd.edges.filter((e) => typeof e === "string");
  if (wanted.length === 0) return { ok: false, reason: "INVALID_TARGET" };
  const next = structuredClone(state);
  const player0 = next.players[cmd.seat];
  player0.devCards.splice(findPlayable(player0, "roadbuilding"), 1);
  player0.devPlayedThisTurn = true;
  const events = [{ type: "DEV_CARD_PLAYED", player: cmd.seat, card: "roadbuilding" }];
  for (const ek of wanted) {
    if (!board.geo.edges[ek]) continue;
    if (next.roads[ek] !== void 0) continue;
    if (countBuildings(next, cmd.seat).roads >= LIMITS.road) continue;
    if (!roadConnected(board, next, ek, cmd.seat)) continue;
    next.roads[ek] = cmd.seat;
    events.push({ type: "ROAD_BUILT", player: cmd.seat, edge: ek });
  }
  return { ok: true, state: next, events };
}
function moveRobber(board, state, seat, tile, stealFrom) {
  if (state.phase !== "play") return { ok: false, reason: "WRONG_PHASE" };
  if (seat !== state.current) return { ok: false, reason: "NOT_YOUR_TURN" };
  if (!state.pendingRobber) return { ok: false, reason: "ROBBER_NOT_PENDING" };
  if (Object.keys(state.pendingDiscards).length > 0) return { ok: false, reason: "DISCARD_PENDING" };
  if (!board.geo.tiles[tile]) return { ok: false, reason: "UNKNOWN_TILE" };
  if (tile === state.robberTile) return { ok: false, reason: "ROBBER_SAME_TILE" };
  const next = structuredClone(state);
  const from = next.robberTile;
  next.robberTile = tile;
  next.pendingRobber = false;
  const events = [{ type: "ROBBER_MOVED", player: seat, from, to: tile }];
  if (stealFrom !== void 0 && stealFrom !== seat) {
    const victim = next.players[stealFrom];
    if (victim && hasBuildingAdjacent(board, next, tile, stealFrom)) {
      const gained = stealRandom(victim);
      if (gained) {
        victim.resources[gained] -= 1;
        next.players[seat].resources[gained] += 1;
        events.push({ type: "CARD_STOLEN", thief: seat, victim: stealFrom });
      }
    }
  }
  return { ok: true, state: next, events };
}

// ../../packages/engine/src/rules/score.ts
var MIN_LONGEST_ROAD = 5;
var MIN_ARMY = 3;
var WIN_SCORE = 10;
function computeLongestRoad(board, state, player) {
  const { geo } = board;
  const myEdges = [];
  for (const ek of Object.keys(state.roads)) {
    if (state.roads[ek] === player) myEdges.push(ek);
  }
  if (myEdges.length === 0) return 0;
  const adj = /* @__PURE__ */ new Map();
  for (const ek of myEdges) {
    const e = geo.edges[ek];
    if (!e) continue;
    for (const vk of [e.a, e.b]) {
      const list = adj.get(vk);
      if (list) list.push(ek);
      else adj.set(vk, [ek]);
    }
  }
  const blocked = (vk) => {
    const b = state.buildings[vk];
    return b !== void 0 && b.owner !== player;
  };
  let best = 0;
  const walk = (vk, used, count) => {
    if (count > best) best = count;
    const list = adj.get(vk);
    if (!list) return;
    for (const ek of list) {
      if (used.has(ek)) continue;
      const e = geo.edges[ek];
      const next = e.a === vk ? e.b : e.a;
      if (blocked(next)) continue;
      used.add(ek);
      walk(next, used, count + 1);
      used.delete(ek);
    }
  };
  for (const start of adj.keys()) {
    if (blocked(start)) continue;
    walk(start, /* @__PURE__ */ new Set(), 0);
  }
  return best;
}
function recomputeLongestRoad(board, state) {
  const lengths = state.players.map((p) => computeLongestRoad(board, state, p.index));
  const current = state.longestRoad;
  if (current) {
    const ownLength = lengths[current.player] ?? 0;
    if (ownLength < MIN_LONGEST_ROAD) {
      state.longestRoad = null;
    } else {
      const challenger = state.players.findIndex(
        (p) => p.index !== current.player && (lengths[p.index] ?? 0) > ownLength
      );
      if (challenger >= 0) {
        state.longestRoad = { player: challenger, length: lengths[challenger] ?? 0 };
      } else {
        state.longestRoad = { player: current.player, length: ownLength };
      }
      return;
    }
  }
  if (state.longestRoad === null) {
    const idx = lengths.findIndex((len) => len >= MIN_LONGEST_ROAD);
    if (idx >= 0) state.longestRoad = { player: idx, length: lengths[idx] ?? 0 };
  }
}
function recomputeLargestArmy(state) {
  const current = state.largestArmy;
  if (current) {
    const ownCount = state.players[current.player]?.playedKnights ?? 0;
    if (ownCount < MIN_ARMY) {
      state.largestArmy = null;
    } else {
      const challenger = state.players.findIndex(
        (p) => p.index !== current.player && p.playedKnights > ownCount
      );
      if (challenger >= 0) {
        state.largestArmy = { player: challenger, count: state.players[challenger].playedKnights };
      } else {
        state.largestArmy = { player: current.player, count: ownCount };
      }
      return;
    }
  }
  if (state.largestArmy === null) {
    let bestIdx = -1;
    let bestCount = 0;
    for (const p of state.players) {
      if (p.playedKnights > bestCount) {
        bestCount = p.playedKnights;
        bestIdx = p.index;
      }
    }
    if (bestCount >= MIN_ARMY) state.largestArmy = { player: bestIdx, count: bestCount };
  }
}
function scoreOf(state, player) {
  let total2 = 0;
  for (const b of Object.values(state.buildings)) {
    if (b.owner !== player) continue;
    total2 += b.city ? 2 : 1;
  }
  if (state.longestRoad?.player === player) total2 += 2;
  if (state.largestArmy?.player === player) total2 += 2;
  const p = state.players[player];
  if (p) {
    for (const entry of p.devCards) {
      if (entry.card === "victory") total2 += 1;
    }
  }
  return total2;
}
function allScores(state) {
  return state.players.map((p) => scoreOf(state, p.index));
}
function findWinner(state) {
  for (const p of state.players) {
    if (scoreOf(state, p.index) >= WIN_SCORE) return p.index;
  }
  return null;
}

// ../../packages/engine/src/rules/trade.ts
function total(count) {
  if (!count) return 0;
  let sum = 0;
  for (const r of RESOURCES) sum += count[r] ?? 0;
  return sum;
}
function portRatioFor(board, state, player, resource) {
  let ratio = 4;
  for (const slot of state.ports) {
    const edge = board.geo.edges[slot.edge];
    if (!edge) continue;
    const ownsHere = state.buildings[edge.a]?.owner === player || state.buildings[edge.b]?.owner === player;
    if (!ownsHere) continue;
    if (slot.port.kind === "generic") {
      ratio = Math.min(ratio, 3);
    } else if (slot.port.resource === resource) {
      ratio = Math.min(ratio, 2);
    }
  }
  return ratio;
}
function tradePlayer(board, state, cmd) {
  if (state.phase !== "play") return { ok: false, reason: "WRONG_PHASE" };
  if (cmd.seat === cmd.withPlayer) return { ok: false, reason: "SAME_TARGET" };
  if (cmd.seat !== state.current && cmd.withPlayer !== state.current) {
    return { ok: false, reason: "NOT_INVOLVED" };
  }
  const a = state.players[cmd.seat];
  const b = state.players[cmd.withPlayer];
  if (!a || !b) return { ok: false, reason: "INVALID_TARGET" };
  if (total(cmd.give) === 0 && total(cmd.get) === 0) {
    return { ok: false, reason: "EMPTY_TRADE" };
  }
  for (const r of RESOURCES) {
    const deltaA = (cmd.get[r] ?? 0) - (cmd.give[r] ?? 0);
    const deltaB = -deltaA;
    if (a.resources[r] + deltaA < 0) return { ok: false, reason: "INSUFFICIENT_RESOURCES" };
    if (b.resources[r] + deltaB < 0) return { ok: false, reason: "INSUFFICIENT_RESOURCES" };
  }
  const next = structuredClone(state);
  const na = next.players[cmd.seat];
  const nb = next.players[cmd.withPlayer];
  for (const r of RESOURCES) {
    const deltaA = (cmd.get[r] ?? 0) - (cmd.give[r] ?? 0);
    na.resources[r] += deltaA;
    nb.resources[r] -= deltaA;
  }
  const events = [
    {
      type: "TRADE_COMPLETED",
      a: cmd.seat,
      b: cmd.withPlayer,
      aGives: cmd.give,
      bGives: cmd.get
    }
  ];
  return { ok: true, state: next, events };
}
function tradeBank(board, state, cmd) {
  if (state.phase !== "play") return { ok: false, reason: "WRONG_PHASE" };
  if (cmd.seat !== state.current) return { ok: false, reason: "NOT_YOUR_TURN" };
  if (cmd.give === cmd.get) return { ok: false, reason: "SAME_TARGET" };
  const player = state.players[cmd.seat];
  if (!player) return { ok: false, reason: "INVALID_TARGET" };
  const ratio = portRatioFor(board, state, cmd.seat, cmd.give);
  if (player.resources[cmd.give] < ratio) {
    return { ok: false, reason: "INSUFFICIENT_RESOURCES" };
  }
  const next = structuredClone(state);
  const p = next.players[cmd.seat];
  p.resources[cmd.give] -= ratio;
  p.resources[cmd.get] += 1;
  const events = [
    { type: "BANK_TRADED", player: cmd.seat, give: cmd.give, get: cmd.get, ratio }
  ];
  return { ok: true, state: next, events };
}
function portTransfer(board, state, cmd) {
  if (state.phase !== "play") return { ok: false, reason: "WRONG_PHASE" };
  if (cmd.seat !== state.current) return { ok: false, reason: "NOT_YOUR_TURN" };
  if (cmd.give === cmd.get) return { ok: false, reason: "SAME_TARGET" };
  const beneficiary = state.players[cmd.beneficiary];
  if (!beneficiary || cmd.beneficiary === cmd.seat) {
    return { ok: false, reason: "INVALID_TARGET" };
  }
  const ratio = portRatioFor(board, state, cmd.seat, cmd.give);
  if (ratio === 4) return { ok: false, reason: "NO_PORT" };
  if (beneficiary.resources[cmd.give] < ratio) {
    return { ok: false, reason: "INSUFFICIENT_RESOURCES" };
  }
  const next = structuredClone(state);
  const ben = next.players[cmd.beneficiary];
  ben.resources[cmd.give] -= ratio;
  ben.resources[cmd.get] += 1;
  const events = [
    {
      type: "PORT_TRANSFERRED",
      executor: cmd.seat,
      beneficiary: cmd.beneficiary,
      give: cmd.give,
      get: cmd.get,
      ratio
    }
  ];
  return { ok: true, state: next, events };
}

// ../../packages/engine/src/engine.ts
function dispatch(board, state, cmd) {
  switch (cmd.type) {
    case "PLACE_SETTLEMENT":
      return placeSettlement(board, state, cmd);
    case "ROLL_DICE":
      return rollDice(board, state, cmd);
    case "BUILD_ROAD":
      return buildRoad(board, state, cmd);
    case "BUILD_SETTLEMENT":
      return buildSettlement(board, state, cmd);
    case "BUILD_CITY":
      return buildCity(board, state, cmd);
    case "BUY_DEV_CARD":
      return buyDevCard(board, state, cmd);
    case "PLAY_KNIGHT":
      return playKnight(board, state, cmd);
    case "PLAY_MONOPOLY":
      return playMonopoly(board, state, cmd);
    case "PLAY_PLENTY":
      return playPlenty(board, state, cmd);
    case "PLAY_ROAD_BUILDING":
      return playRoadBuilding(board, state, cmd);
    case "TRADE_PLAYER":
      return tradePlayer(board, state, cmd);
    case "TRADE_BANK":
      return tradeBank(board, state, cmd);
    case "PORT_TRANSFER":
      return portTransfer(board, state, cmd);
    case "DISCARD":
      return discardCards(board, state, cmd);
    case "MOVE_ROBBER":
      return moveRobber(board, state, cmd.seat, cmd.tile, cmd.stealFrom);
    case "END_TURN":
      return endTurn(state, cmd.seat);
    default:
      return { ok: false, reason: "UNKNOWN_COMMAND" };
  }
}
var ROAD_AFFECTING = /* @__PURE__ */ new Set([
  "BUILD_ROAD",
  "BUILD_SETTLEMENT",
  "BUILD_CITY",
  "PLAY_ROAD_BUILDING"
]);
function applyCommand(board, state, cmd) {
  const discarding = Object.keys(state.pendingDiscards).length > 0;
  if (discarding && cmd.type !== "DISCARD") {
    return { ok: false, reason: "DISCARD_PENDING" };
  }
  if (!discarding && state.pendingRobber && cmd.type !== "MOVE_ROBBER") {
    return { ok: false, reason: "ROBBER_PENDING" };
  }
  const result = dispatch(board, state, cmd);
  if (!result.ok) return result;
  const next = result.state;
  const events = result.events;
  if (ROAD_AFFECTING.has(cmd.type)) {
    const previous = next.longestRoad?.player ?? null;
    recomputeLongestRoad(board, next);
    const holder = next.longestRoad?.player ?? null;
    if (holder !== previous) {
      events.push({
        type: "LONGEST_ROAD_CHANGED",
        player: holder ?? -1,
        previous,
        length: next.longestRoad?.length ?? 0
      });
    }
  }
  if (cmd.type === "PLAY_KNIGHT") {
    const previous = next.largestArmy?.player ?? null;
    recomputeLargestArmy(next);
    const holder = next.largestArmy?.player ?? null;
    if (holder !== previous) {
      events.push({
        type: "LARGEST_ARMY_CHANGED",
        player: holder ?? -1,
        previous,
        count: next.largestArmy?.count ?? 0
      });
    }
  }
  if (next.phase === "play") {
    const winner = findWinner(next);
    if (winner !== null) {
      next.phase = "ended";
      next.winner = winner;
      events.push({ type: "GAME_WON", player: winner, score: scoreOf(next, winner) });
    }
  }
  return { ok: true, state: next, events };
}

// ../../packages/engine/src/rules/view.ts
function handSize2(res) {
  return RESOURCES.reduce((sum, r) => sum + res[r], 0);
}
function viewFor(board, state, viewer) {
  const tiles = board.geo.tileKeys.map((key) => {
    const t = state.tiles[key];
    return {
      key,
      terrain: t.terrain,
      number: t.number,
      hasRobber: key === state.robberTile
    };
  });
  const players = state.players.map((p) => ({
    index: p.index,
    name: p.name,
    color: p.color,
    handSize: handSize2(p.resources),
    devCardCount: p.devCards.length,
    playedKnights: p.playedKnights,
    score: scoreOf(state, p.index)
  }));
  const subject = state.players[viewer];
  if (!subject) throw new Error(`\u65E0\u6548\u7684\u89C2\u5BDF\u8005: ${viewer}`);
  const me = {
    index: subject.index,
    name: subject.name,
    color: subject.color,
    handSize: handSize2(subject.resources),
    devCardCount: subject.devCards.length,
    playedKnights: subject.playedKnights,
    score: scoreOf(state, viewer),
    resources: { ...subject.resources },
    devCards: subject.devCards.map((e) => ({ ...e }))
  };
  return {
    viewer,
    phase: state.phase,
    current: state.current,
    turn: state.turn,
    hasRolled: state.hasRolled,
    dice: state.dice ? [state.dice[0], state.dice[1]] : null,
    winner: state.winner,
    tiles,
    ports: state.ports.map((p) => ({ ...p, port: { ...p.port } })),
    buildings: structuredClone(state.buildings),
    roads: { ...state.roads },
    robberTile: state.robberTile,
    players,
    me,
    scores: allScores(state),
    longestRoad: state.longestRoad ? { ...state.longestRoad } : null,
    largestArmy: state.largestArmy ? { ...state.largestArmy } : null,
    devDeckCount: state.devDeck.length,
    setup: state.setup ? { ...state.setup } : null,
    // 只把「谁还欠几张」带出去，弃了哪几种资源不进视图
    pendingDiscards: Object.entries(state.pendingDiscards).map(([seat, count]) => ({ player: Number(seat), count })).sort((a, b) => a.player - b.player),
    pendingRobber: state.pendingRobber
  };
}

// ../../packages/protocol/src/index.ts
var DEFAULT_SETTINGS = { setupGrant: true };
function encode(msg) {
  return JSON.stringify(msg);
}
function decodeClientMessage(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const t = parsed.t;
  if (t === "JOIN") {
    const roomId = parsed.roomId;
    const name = parsed.name;
    return {
      t: "JOIN",
      roomId: typeof roomId === "string" ? roomId : "main",
      name: typeof name === "string" ? name : ""
    };
  }
  if (t === "SET_SETTINGS") {
    const setupGrant = parsed.setupGrant;
    if (typeof setupGrant !== "boolean") return null;
    return { t: "SET_SETTINGS", setupGrant };
  }
  if (t === "START") return { t: "START" };
  if (t === "COMMAND") {
    const cmd = parsed.cmd;
    if (typeof cmd !== "object" || cmd === null) return null;
    if (typeof cmd.type !== "string") return null;
    return { t: "COMMAND", cmd };
  }
  if (t === "PING") {
    const id = parsed.id;
    return typeof id === "number" ? { t: "PING", id } : { t: "PING" };
  }
  if (t === "OFFER") {
    const { to, give, get } = parsed;
    if (typeof to !== "number" || typeof give !== "object" || give === null || typeof get !== "object" || get === null) {
      return null;
    }
    return { t: "OFFER", to, give, get };
  }
  if (t === "OFFER_ACCEPT") return { t: "OFFER_ACCEPT" };
  if (t === "OFFER_REJECT") return { t: "OFFER_REJECT" };
  if (t === "OFFER_CANCEL") return { t: "OFFER_CANCEL" };
  return null;
}

// src/room.ts
var MAX_NAME = 16;
function normalizeName(raw, seat) {
  const trimmed = raw.trim().replace(/\s+/g, " ");
  if (trimmed.length === 0) return `\u73A9\u5BB6 ${seat + 1}`;
  return trimmed.slice(0, MAX_NAME);
}
function sanitizeCount(raw) {
  const out = {};
  for (const r of RESOURCES) {
    const n = raw[r];
    if (typeof n === "number" && Number.isFinite(n) && n > 0) out[r] = Math.floor(n);
  }
  return out;
}
function countOf(res) {
  let sum = 0;
  for (const r of RESOURCES) sum += res[r] ?? 0;
  return sum;
}
var Room = class {
  id;
  board;
  capacity;
  /** null = 还在等待开局 */
  game = null;
  members = [];
  sockets = /* @__PURE__ */ new Map();
  seq = 0;
  /** 桌面上挂着的报价；同一时间只允许一条，避免桌面变成拍卖行 */
  offer = null;
  /** 房间级规则设置：只在开局前可改，开局后锁定到整局结束 */
  settings = { ...DEFAULT_SETTINGS };
  constructor(id, opts = {}) {
    this.id = id;
    this.board = opts.board ?? buildBoard(MAP_4P);
    const cap = opts.capacity ?? 4;
    this.capacity = Math.max(2, Math.min(PLAYER_COLORS.length, Math.floor(cap)));
  }
  // -------------------------------------------------------------------------
  // 只读
  // -------------------------------------------------------------------------
  get started() {
    return this.game !== null;
  }
  get playerCount() {
    return this.members.length;
  }
  get connectedCount() {
    let n = 0;
    for (const m of this.members) if (m.connected) n++;
    return n;
  }
  get version() {
    return this.seq;
  }
  get roomSettings() {
    return { ...this.settings };
  }
  get settingsLocked() {
    return this.game !== null;
  }
  /** 开局前改设置；已开局一律拒绝，避免打一半改规则 */
  setSettings(patch) {
    if (this.settingsLocked) return false;
    if (typeof patch.setupGrant === "boolean") this.settings.setupGrant = patch.setupGrant;
    return true;
  }
  /** 把权威设置推给房间内所有人，客户端只负责显示 */
  broadcastSettings() {
    this.sendAll({ t: "SETTINGS", settings: this.roomSettings, locked: this.settingsLocked });
  }
  lobbyPlayers() {
    return this.members.map((m) => ({ seat: m.seat, name: m.name, connected: m.connected }));
  }
  seatOfName(name) {
    const clean = name.trim();
    const hit = this.members.find((m) => m.name === clean);
    return hit ? hit.seat : null;
  }
  isSeated(seat) {
    return this.members.some((m) => m.seat === seat);
  }
  viewOf(seat) {
    if (!this.game) return null;
    if (!this.isSeated(seat)) return null;
    return viewFor(this.board, this.game, seat);
  }
  // -------------------------------------------------------------------------
  // 入座
  // -------------------------------------------------------------------------
  /**
   * 入座规则（宁可简单可预测）：
   * 1. 同名且原座位没人连着 → 视为重连，回到原座位（T7 的地基）
   * 2. 同名但座位有人连着 → SEAT_TAKEN，防止顶号
   * 3. 未开局 → 按入座顺序分配下一个空位
   * 4. 已开局 → 不再加人（观战留到后面）
   */
  join(rawName, socket) {
    const bySeat = this.members.length;
    const name = normalizeName(rawName, bySeat);
    const existing = this.members.find((m) => m.name === name);
    if (existing) {
      const live = this.sockets.get(existing.seat);
      if (live && live !== socket) return { ok: false, reason: "SEAT_TAKEN" };
      this.sockets.set(existing.seat, socket);
      existing.connected = true;
      if (this.game) this.game.players[existing.seat].name = name;
      return { ok: true, seat: existing.seat, view: this.viewOf(existing.seat), reclaimed: true };
    }
    if (this.members.length >= this.capacity) return { ok: false, reason: "ROOM_FULL" };
    if (this.game) return { ok: false, reason: "IN_PROGRESS" };
    const seat = this.members.length;
    const finalName = normalizeName(rawName, seat);
    this.members.push({ seat, name: finalName, connected: true });
    this.sockets.set(seat, socket);
    if (this.members.length === this.capacity) this.start();
    return { ok: true, seat, view: this.viewOf(seat), reclaimed: false };
  }
  reconnect(seat, socket) {
    const member = this.members.find((m) => m.seat === seat);
    if (!member) return;
    this.sockets.set(seat, socket);
    member.connected = true;
  }
  /** 断线不释放座位：30 分钟内可原座重连（T7） */
  leave(seat) {
    const member = this.members.find((m) => m.seat === seat);
    if (!member) return;
    this.sockets.delete(seat);
    member.connected = false;
  }
  // -------------------------------------------------------------------------
  // 开局
  // -------------------------------------------------------------------------
  start() {
    if (this.game) return { ok: false, reason: "ALREADY_STARTED" };
    if (this.members.length < 2) return { ok: false, reason: "NEED_MORE_PLAYERS" };
    const ordered = this.members.slice().sort((a, b) => a.seat - b.seat);
    const names = ordered.map((m) => m.name);
    const colors = Array.from(PLAYER_COLORS).slice(0, names.length);
    this.game = createGame(this.board, names, colors, this.settings.setupGrant);
    this.seq += 1;
    return { ok: true };
  }
  // -------------------------------------------------------------------------
  // 命令
  // -------------------------------------------------------------------------
  /**
   * 裁决一条命令。
   *
   * **座位以连接为准**：客户端 JSON 里的 seat 一律被覆盖，
   * 否则任何人改个数字就能替别人行动。
   */
  command(seat, cmd) {
    if (!this.isSeated(seat)) {
      this.sendTo(seat, { t: "REJECT", reason: "NOT_SEATED" });
      return { ok: false, reason: "NOT_SEATED" };
    }
    const game = this.game;
    if (!game) {
      this.sendTo(seat, { t: "REJECT", reason: "GAME_NOT_STARTED" });
      return { ok: false, reason: "GAME_NOT_STARTED" };
    }
    const allowFakeDice = process.env.HEXFONT_FAKE_DICE === "1";
    const safe = allowFakeDice ? { ...cmd, seat } : { ...cmd, dice: void 0, seat };
    const result = applyCommand(this.board, game, safe);
    if (!result.ok) {
      this.sendTo(seat, { t: "REJECT", reason: result.reason, detail: result.detail });
      return { ok: false, reason: result.reason };
    }
    this.game = result.state;
    this.seq += 1;
    if (cmd.type === "END_TURN" && this.offer) {
      this.offer = null;
      this.broadcastOffer();
    }
    return { ok: true, seq: this.seq, events: result.events };
  }
  // -------------------------------------------------------------------------
  // 交易报价
  // -------------------------------------------------------------------------
  get currentOffer() {
    return this.offer;
  }
  /**
   * 挂一条报价。
   * 同一时间只允许一条 —— 桌上只有一个人说话，多挂几条会变成拍卖行。
   */
  makeOffer(seat, to, rawGive, rawGet) {
    if (!this.game || !this.isSeated(seat) || !this.isSeated(to) || seat === to) {
      this.sendTo(seat, { t: "REJECT", reason: "BAD_OFFER" });
      return false;
    }
    const give = sanitizeCount(rawGive);
    const get = sanitizeCount(rawGet);
    if (countOf(give) === 0 && countOf(get) === 0) {
      this.sendTo(seat, { t: "REJECT", reason: "BAD_OFFER", detail: "\u4EA4\u6613\u5185\u5BB9\u4E3A\u7A7A" });
      return false;
    }
    this.offer = { from: seat, to, give, get };
    this.broadcastOffer();
    return true;
  }
  /** 被报价方接受：交给引擎执行，资源够不够由引擎裁决 */
  acceptOffer(seat) {
    const offer = this.offer;
    if (!offer || offer.to !== seat) {
      this.sendTo(seat, { t: "REJECT", reason: "BAD_OFFER", detail: "\u6CA1\u6709\u6307\u5411\u4F60\u7684\u62A5\u4EF7" });
      return { ok: false, reason: "BAD_OFFER" };
    }
    const outcome = this.command(offer.from, {
      type: "TRADE_PLAYER",
      seat: offer.from,
      withPlayer: offer.to,
      give: offer.give,
      get: offer.get
    });
    if (!outcome.ok) return outcome;
    this.offer = null;
    this.broadcastOffer();
    return outcome;
  }
  rejectOffer(seat) {
    if (!this.offer || this.offer.to !== seat) return;
    this.offer = null;
    this.broadcastOffer();
  }
  cancelOffer(seat) {
    if (!this.offer || this.offer.from !== seat) return;
    this.offer = null;
    this.broadcastOffer();
  }
  broadcastOffer() {
    this.sendAll({ t: "OFFER", offer: this.offer });
  }
  // -------------------------------------------------------------------------
  // 广播
  // -------------------------------------------------------------------------
  /** 按座位裁剪视角后逐人推送。events 只用于让客户端播放动效，不参与状态还原。 */
  sync(events = []) {
    const game = this.game;
    if (!game) {
      this.sendAll({
        t: "LOBBY",
        roomId: this.id,
        capacity: this.capacity,
        players: this.lobbyPlayers()
      });
      return;
    }
    for (const [seat, socket] of this.sockets) {
      const view = viewFor(this.board, game, seat);
      socket.send(encode({ t: "STATE", seq: this.seq, events, view }));
    }
  }
  sendTo(seat, msg) {
    this.sockets.get(seat)?.send(encode(msg));
  }
  sendAll(msg) {
    const payload = encode(msg);
    for (const socket of this.sockets.values()) socket.send(payload);
  }
};
var ROOM_ID_RE = /^[a-z0-9_-]{1,24}$/;
function normalizeRoomId(raw) {
  const id = raw.trim().toLowerCase();
  return ROOM_ID_RE.test(id) ? id : null;
}
var RoomRegistry = class {
  rooms = /* @__PURE__ */ new Map();
  capacity;
  maxRooms;
  board;
  constructor(opts = {}) {
    this.capacity = opts.capacity ?? 4;
    this.maxRooms = opts.maxRooms ?? 64;
    this.board = opts.board;
  }
  get size() {
    return this.rooms.size;
  }
  getOrCreate(id) {
    const hit = this.rooms.get(id);
    if (hit) return hit;
    if (this.rooms.size >= this.maxRooms) return null;
    const room = new Room(id, { capacity: this.capacity, board: this.board });
    this.rooms.set(id, room);
    return room;
  }
  get(id) {
    return this.rooms.get(id);
  }
  list() {
    return Array.from(this.rooms.values());
  }
};

// src/server.ts
var MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2"
};
var cachedRoot;
function webRoot() {
  if (cachedRoot !== void 0) return cachedRoot;
  const entryDir = import_node_path.default.dirname(process.argv[1] ?? process.cwd());
  const candidates = [
    import_node_path.default.join(entryDir, "public"),
    import_node_path.default.join(entryDir, "..", "web", "dist"),
    import_node_path.default.join(process.cwd(), "public"),
    import_node_path.default.join(process.cwd(), "..", "web", "dist"),
    import_node_path.default.join(process.cwd(), "apps", "web", "dist")
  ];
  for (const dir of candidates) {
    if (import_node_fs.default.existsSync(import_node_path.default.join(dir, "index.html"))) {
      cachedRoot = import_node_path.default.resolve(dir);
      return cachedRoot;
    }
  }
  cachedRoot = null;
  return null;
}
function resolveWebFile(pathname) {
  const root = webRoot();
  if (!root) return null;
  let clean;
  try {
    clean = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const rel = clean === "/" ? "index.html" : clean.replace(/^\/+/, "");
  const abs = import_node_path.default.resolve(root, rel);
  if (!abs.startsWith(root)) return null;
  try {
    if (!import_node_fs.default.statSync(abs).isFile()) return null;
  } catch {
    return null;
  }
  return abs;
}
function serveFile(res, file) {
  const ext = import_node_path.default.extname(file).toLowerCase();
  const isHashed = /-[A-Za-z0-9_]{8}\./.test(import_node_path.default.basename(file));
  const headers = {
    "content-type": MIME[ext] ?? "application/octet-stream",
    // 带 hash 的资源可以长缓存；index.html 必须每次回源，否则更新后用户看到旧版
    "cache-control": isHashed && ext !== ".html" ? "public, max-age=31536000, immutable" : "no-cache"
  };
  try {
    const body = import_node_fs.default.readFileSync(file);
    res.writeHead(200, headers);
    res.end(body);
  } catch {
    res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    res.end("read error");
  }
}
var HEALTH_PLACEHOLDER = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>\u516D\u89D2\u62D3\u8352 \xB7 \u670D\u52A1\u7AEF</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0d2230;color:#dbe8ec;
       font-family:-apple-system,"PingFang SC",sans-serif}
  .box{text-align:center;padding:28px 34px;border:1px solid rgba(255,255,255,.14);border-radius:16px;
       background:rgba(255,255,255,.04)}
  h1{font-size:16px;margin:0 0 6px;letter-spacing:.08em}
  p{margin:0;font-size:12px;color:#7fa3b1}
</style></head>
<body><div class="box"><h1>\u516D\u89D2\u62D3\u8352 \xB7 \u670D\u52A1\u7AEF\u5728\u7EBF</h1>
<p>WebSocket \u5DF2\u5C31\u7EEA\uFF0C\u7B49\u5F85\u524D\u7AEF\u6784\u5EFA\u4EA7\u7269</p></div></body></html>`;
function createAppServer(opts = {}) {
  const registry = new RoomRegistry({ capacity: opts.capacity });
  const heartbeatMs = opts.heartbeatMs ?? 3e4;
  const httpServer = import_node_http.default.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/health") {
      const rooms = registry.list().map((r) => ({
        id: r.id,
        players: r.playerCount,
        connected: r.connectedCount,
        started: r.started,
        turn: r.game?.turn ?? 0
      }));
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, rooms }));
      return;
    }
    if (url.pathname !== "/") {
      const file = resolveWebFile(url.pathname);
      if (file) {
        serveFile(res, file);
        return;
      }
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("not found");
      return;
    }
    const index = resolveWebFile("/");
    if (index) {
      serveFile(res, index);
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(HEALTH_PLACEHOLDER);
  });
  const wss = new import_websocket_server.default({ server: httpServer, maxPayload: 64 * 1024 });
  const sessions = /* @__PURE__ */ new Map();
  wss.on("connection", (ws) => {
    let alive = true;
    ws.on("pong", () => {
      alive = true;
    });
    const reply = (msg) => {
      if (ws.readyState === ws.OPEN) ws.send(encode(msg));
    };
    ws.on("message", (raw) => {
      const msg = decodeClientMessage(raw.toString());
      if (!msg) {
        reply({ t: "JOIN_FAILED", reason: "BAD_MESSAGE" });
        return;
      }
      switch (msg.t) {
        case "PING":
          reply({ t: "PONG", id: msg.id });
          return;
        case "JOIN": {
          const roomId = normalizeRoomId(msg.roomId) ?? "main";
          const room = registry.getOrCreate(roomId);
          if (!room) {
            reply({ t: "JOIN_FAILED", reason: "ROOM_LIMIT" });
            return;
          }
          const result = room.join(msg.name, { send: (data) => ws.send(data) });
          if (!result.ok) {
            reply({ t: "JOIN_FAILED", reason: result.reason });
            return;
          }
          sessions.set(ws, { room, seat: result.seat });
          reply({
            t: "WELCOME",
            roomId: room.id,
            seat: result.seat,
            capacity: room.capacity,
            players: room.lobbyPlayers(),
            view: result.view,
            offer: room.currentOffer
          });
          room.broadcastSettings();
          room.sync();
          return;
        }
        case "SET_SETTINGS": {
          const session = sessions.get(ws);
          if (!session) {
            reply({ t: "REJECT", reason: "NOT_SEATED" });
            return;
          }
          session.room.setSettings({ setupGrant: msg.setupGrant });
          session.room.broadcastSettings();
          return;
        }
        case "OFFER": {
          const session = sessions.get(ws);
          if (!session) {
            reply({ t: "REJECT", reason: "NOT_SEATED" });
            return;
          }
          session.room.makeOffer(session.seat, msg.to, msg.give, msg.get);
          return;
        }
        case "OFFER_ACCEPT": {
          const session = sessions.get(ws);
          if (!session) {
            reply({ t: "REJECT", reason: "NOT_SEATED" });
            return;
          }
          const outcome = session.room.acceptOffer(session.seat);
          if (outcome.ok) session.room.sync(outcome.events);
          return;
        }
        case "OFFER_REJECT": {
          const session = sessions.get(ws);
          if (!session) {
            reply({ t: "REJECT", reason: "NOT_SEATED" });
            return;
          }
          session.room.rejectOffer(session.seat);
          return;
        }
        case "OFFER_CANCEL": {
          const session = sessions.get(ws);
          if (!session) {
            reply({ t: "REJECT", reason: "NOT_SEATED" });
            return;
          }
          session.room.cancelOffer(session.seat);
          return;
        }
        case "START": {
          const session = sessions.get(ws);
          if (!session) {
            reply({ t: "REJECT", reason: "NOT_SEATED" });
            return;
          }
          const started = session.room.start();
          if (!started.ok) {
            reply({ t: "REJECT", reason: started.reason === "ALREADY_STARTED" ? "WRONG_PHASE" : "NOT_YOUR_TURN" });
            return;
          }
          session.room.sync();
          return;
        }
        case "COMMAND": {
          const session = sessions.get(ws);
          if (!session) {
            reply({ t: "REJECT", reason: "NOT_SEATED" });
            return;
          }
          const outcome = session.room.command(session.seat, msg.cmd);
          if (outcome.ok) session.room.sync(outcome.events);
          return;
        }
        default:
          reply({ t: "JOIN_FAILED", reason: "BAD_MESSAGE" });
      }
    });
    ws.on("close", () => {
      const session = sessions.get(ws);
      if (!session) return;
      sessions.delete(ws);
      session.room.leave(session.seat);
      session.room.sync();
    });
    ws.on("error", () => {
    });
    if (heartbeatMs > 0) {
      const timer = setInterval(() => {
        if (!alive) {
          ws.terminate();
          return;
        }
        alive = false;
        try {
          ws.ping();
        } catch {
          ws.terminate();
        }
      }, heartbeatMs);
      ws.on("close", () => clearInterval(timer));
    }
  });
  return {
    registry,
    httpServer,
    async listen() {
      const port2 = opts.port ?? 8787;
      const host2 = opts.host ?? "0.0.0.0";
      await new Promise((resolve, reject) => {
        httpServer.once("error", reject);
        httpServer.listen(port2, host2, () => {
          httpServer.off("error", reject);
          resolve();
        });
      });
      const addr = httpServer.address();
      return typeof addr === "object" && addr ? addr.port : port2;
    },
    async close() {
      for (const ws of wss.clients) ws.terminate();
      await new Promise((resolve) => wss.close(() => resolve()));
      await new Promise((resolve) => httpServer.close(() => resolve()));
    }
  };
}

// src/index.ts
var port = Number(process.env.PORT ?? 8787);
var host = process.env.HOST ?? "0.0.0.0";
var app = createAppServer({ port, host });
app.listen().then((actual) => {
  console.log(`[hexfront] server listening on http://${host}:${actual}`);
  console.log("[hexfront] ws endpoint: ws://<host>:<port>/?sharecode=<code>");
}).catch((err) => {
  console.error("[hexfront] failed to listen:", err);
  process.exit(1);
});
var closing = false;
var shutdown = (signal) => {
  if (closing) return;
  closing = true;
  console.log(`[hexfront] ${signal} received, shutting down`);
  app.close().then(() => process.exit(0)).catch(() => process.exit(1));
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
