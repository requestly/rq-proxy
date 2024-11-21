// Move Proxy code to this package
var net = require("net");
import http from "http"
import Proxy from "../../lib/proxy";
import {
  getRequestHeaders,
  getRequestContentTypeHeader,
  getResponseContentTypeHeader,
  getResponseHeaders,
  getResponseStatusCode,
  get_request_options,
  get_response_options,
  handleRQMetadataInQueryParam,
} from "./helpers/proxy_ctx_helper";

import RulesMiddleware from "./middlewares/rules_middleware";
import AmisuingMiddleware from "./middlewares/amiusing_middleware";
import LoggerMiddleware from "./middlewares/logger_middleware";
import SslCertMiddleware from "./middlewares/ssl_cert_middleware";
import CtxRQNamespace from "./helpers/ctx_rq_namespace";
import { bodyParser, getContentType } from "./helpers/http_helpers";
import { RQ_INTERCEPTED_CONTENT_TYPES } from "./constants";
import { CONSTANTS as GLOBAL_CONSTANTS } from "@requestly/requestly-core";
// import SSLProxyingConfigFetcher from "renderer/lib/fetcher/ssl-proxying-config-fetcher";
// import SSLProxyingManager from "../ssl-proxying/ssl-proxying-manager";

export const MIDDLEWARE_TYPE = {
  AMIUSING: "AMIUSING",
  RULES: "RULES",
  LOGGER: "LOGGER",
  SSL_CERT: "SSL_CERT",
  GLOBAL_STATE: "GLOBAL_STATE", // SEEMS UNUSUED, BUT ADDING FOR COMPLETENESS
};

class ProxyMiddlewareManager {
  constructor(
    proxy,
    proxyConfig,
    rulesHelper,
    loggerService,
    sslConfigFetcher,
  ) {
    /*
    {
      AMIUSING: true,
      PROXY: true,
      LOGGER: true,
      SSL_CERT: true
    }
    */
    this.config = {};
    this.init_config();

    this.proxy = proxy;
    this.proxyConfig = proxyConfig;
    this.rulesHelper = rulesHelper;
    this.loggerService = loggerService;

    this.sslConfigFetcher = sslConfigFetcher;
    // this.sslProxyingManager = new SSLProxyingManager(sslConfigFetcher);
  }

  /* NOT USEFUL */
  init_config = (config = {}) => {
    Object.keys(MIDDLEWARE_TYPE).map((middleware_key) => {
      this.config[middleware_key] =
        config[middleware_key] !== undefined ? !!config[middleware_key] : true;
    });
  };

  init = (config = {}) => {
    this.init_config(config);
    this.request_handler_idx = 42;

    if (!this.proxy) {
      return;
    }

    this.init_handlers();
  };

  /* 
    This is used to init a sequential handler
  */
  init_request_handler = (fn, is_detachable = false) => {
    if (is_detachable) {
      const idx = this.request_handler_idx;
      this.proxy.onRequestSetArray(idx, fn);
      this.request_handler_idx++;
      return idx;
    }

    this.proxy.onRequest(fn);
  };

  init_amiusing_handler = () => {
    const amiusing_middleware = new AmisuingMiddleware(
      this.config[MIDDLEWARE_TYPE.AMIUSING]
    );
    this.init_request_handler((ctx, callback) => {
      amiusing_middleware.on_request(ctx);
      callback();
    }, true);
  };

  init_ssl_cert_handler = () => {
    const ssl_cert_middleware = new SslCertMiddleware(
      this.config[MIDDLEWARE_TYPE.SSL_CERT],
      this.proxyConfig.rootCertPath
    );
    this.init_request_handler((ctx, callback) => {
      ssl_cert_middleware.on_request(ctx);
      callback();
    }, true);
  };

  init_main_handler = () => {
    const self = this;
    const is_detachable = true;
    const logger_middleware = new LoggerMiddleware(
      this.config[MIDDLEWARE_TYPE.LOGGER],
      this.loggerService
    );

    const idx = this.init_request_handler(async (ctx, callback) => {
      ctx.rq = new CtxRQNamespace();
      ctx.rq.set_original_request(get_request_options(ctx));
      ctx.proxyToServerRequestOptions.rejectUnauthorized = false;

      handleRQMetadataInQueryParam(ctx);

      // Figure out a way to enable/disable middleware dynamically
      // instead of re-initing this again
      const rules_middleware = new RulesMiddleware(
        this.config[MIDDLEWARE_TYPE.RULES],
        ctx,
        this.rulesHelper
      );

      ctx.onError(async function (ctx, err, kind, callback) {
        // Should only modify response body & headers
        ctx.rq_response_body = "" + kind + ": " + err, "utf8";
        const { action_result_objs, continue_request } = await rules_middleware.on_response(ctx);

        // Only modify response if any modify_response action is applied
        const modifyResponseActionExist = action_result_objs.some((action_result_obj) => action_result_obj?.action?.action === "modify_response")

        if(modifyResponseActionExist) {
          const statusCode = ctx.rq_response_status_code || 404;
          const responseHeaders = getResponseHeaders(ctx) || {}
          ctx.proxyToClientResponse.writeHead(
              statusCode,
              http.STATUS_CODES[statusCode],
              responseHeaders
            );
          ctx.proxyToClientResponse.end(ctx.rq_response_body);

          ctx.rq.set_final_response({
              status_code: statusCode,
              headers: responseHeaders,
              body: ctx.rq_response_body,
            });
          logger_middleware.send_network_log(
              ctx,
              rules_middleware.action_result_objs,
              GLOBAL_CONSTANTS.REQUEST_STATE.COMPLETE
            )
        }

        return callback();
      })

      let request_body_chunks = [];
      ctx.onRequestData(async function (ctx, chunk, callback) {
        if (chunk) {
          request_body_chunks.push(chunk);
        }
        return callback(null, null); // don't write chunks to client Request
      });

      ctx.onRequestEnd(async function (ctx, callback) {
        let body = new Buffer.concat(request_body_chunks);
        const contentTypeHeader = getRequestContentTypeHeader(ctx);
        const contentType = getContentType(contentTypeHeader);
        const parsedBody = bodyParser(contentTypeHeader, body);

        let pre_final_body = parsedBody || body.toString("utf8");
        ctx.rq.set_original_request({ body: pre_final_body });
        ctx.rq_request_body = pre_final_body;

        if (parsedBody && RQ_INTERCEPTED_CONTENT_TYPES.includes(contentType)) {
          // Do modifications, if any
          const { action_result_objs, continue_request } =
            await rules_middleware.on_request_end(ctx);
        }

        // Use the updated request
        ctx.proxyToServerRequest.write(ctx.rq_request_body);
        ctx.rq.set_final_request({ body: ctx.rq_request_body });

        return callback();
      });

      ctx.onResponse(async (ctx, callback) => {
        ctx.rq.set_original_response(get_response_options(ctx));
        const { action_result_objs, continue_request: continue_response } =
          await rules_middleware.on_response(ctx);
        if (continue_response) {
          return callback();
        }
      });

      let response_body_chunks = [];
      ctx.onResponseData(async function (ctx, chunk, callback) {
        if (chunk) {
          response_body_chunks.push(chunk);
        }
        return callback(null, null); // don't write chunks to client response
      });

      ctx.onResponseEnd(async function (ctx, callback) {
        let body = new Buffer.concat(response_body_chunks);
        const contentTypeHeader = getResponseContentTypeHeader(ctx);
        const contentType = getContentType(contentTypeHeader);
        const parsedBody = bodyParser(contentTypeHeader, body);
        ctx.rq.set_original_response({ body: parsedBody });

        ctx.rq_response_body = body;
        ctx.rq_parsed_response_body = parsedBody;
        ctx.rq_response_status_code = getResponseStatusCode(ctx);

        if (RQ_INTERCEPTED_CONTENT_TYPES.includes(contentType) && parsedBody) {
          ctx.rq_response_body = parsedBody;
          ctx.rq.set_original_response({ body: parsedBody });
        }
        const { action_result_objs, continue_request } = await rules_middleware.on_response_end(ctx);


        const statusCode = ctx.rq_response_status_code || getResponseStatusCode(ctx);
        ctx.proxyToClientResponse.writeHead(
          statusCode,
          http.STATUS_CODES[statusCode],
          getResponseHeaders(ctx)
        );

        ctx.proxyToClientResponse.write(ctx.rq_response_body);

        ctx.rq.set_final_response({
          ...get_response_options(ctx),
          status_code:
            ctx.rq_response_status_code || getResponseStatusCode(ctx),
          body: ctx.rq_response_body,
        });
        logger_middleware.send_network_log(
          ctx,
          rules_middleware.action_result_objs,
          GLOBAL_CONSTANTS.REQUEST_STATE.COMPLETE
        );

        return callback();
      });

      // Remove headers that may conflict
      delete getRequestHeaders(ctx)["content-length"];

      const { action_result_objs, continue_request } = await rules_middleware.on_request(ctx);

      ctx.rq.set_final_request(get_request_options(ctx));
      // TODO: Removing this log for now. Will add this when support is added for upsert in firebase logs.
      logger_middleware.send_network_log(
        ctx,
        rules_middleware.action_result_objs,
        GLOBAL_CONSTANTS.REQUEST_STATE.LOADING
      );
      //logger
      if (continue_request) {
        return callback();
      }
    }, is_detachable);
  };

  init_ssl_tunneling_handler = () => {
    this.proxy.onConnect(async (req, socket, head, callback) => {
      const host = req.url.split(":")[0];
      const port = req.url.split(":")[1];
      const origin = `https://${host}`;

      const isSSLProxyingActive =
        this.sslProxyingManager.isSslProxyingActive(origin);
      if (isSSLProxyingActive) {
        return callback();
      }

      // TODO: @sahil add logger here for CONNECT request

      console.log("Tunnel to", req.url);

      // Hack: For timing out tunnel in case of inclusionList/ExclusionList Change
      global.rq.sslTunnelingSocketsMap[req.url] = socket;

      var conn = net.connect(
        {
          port: port,
          host: host,
          allowHalfOpen: false,
        },
        async function () {
          conn.on("finish", () => {
            console.log(`Finish ${host}`);
            socket.destroy();
            delete global.rq.sslTunnelingSocketsMap[req.url];
          });
          socket.on("close", () => {
            console.log("Close");
            conn.end();
          });
          // socket.on('data', (data) => {
          //   // console.log("FROM SOCKET: " + data.toString("ascii") + "\n");
          //   console.log("FROM SOCKET: data");
          // });
          // conn.on('data', (data) => {
          //   // console.log("FROM CONN: " + data.toString("ascii") + "\n");
          //   console.log("FROM CONN: data");
          // });
          socket.write("HTTP/1.1 200 OK\r\n\r\n", "UTF-8", function () {
            conn.pipe(socket);
            socket.pipe(conn);
          });
        }
      );

      conn.on("error", function (err) {
        filterSocketConnReset(err, "PROXY_TO_SERVER_SOCKET");
      });
      socket.on("error", function (err) {
        filterSocketConnReset(err, "CLIENT_TO_PROXY_SOCKET");
      });
    });

    // Since node 0.9.9, ECONNRESET on sockets are no longer hidden
    function filterSocketConnReset(err, socketDescription) {
      if (err.errno === "ECONNRESET") {
        console.log("Got ECONNRESET on " + socketDescription + ", ignoring.");
      } else {
        console.log("Got unexpected error on " + socketDescription, err);
      }
    }
  };

  init_handlers = () => {
    this.proxy.onRequestHandlers = [];
    this.proxy.onConnectHandlers = [];
    this.proxy.use(Proxy.gunzip);

    // this.init_ssl_tunneling_handler();
    this.init_amiusing_handler();
    this.init_ssl_cert_handler();
    this.init_main_handler();
  };
}

export default ProxyMiddlewareManager;
