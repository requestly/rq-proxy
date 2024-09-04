import { cloneDeep } from "lodash";
import HTTPSnippet from "httpsnippet";
import { get_success_actions_from_action_results, getHost } from "../rule_action_processor/utils";
import { createHar } from "../helpers/harObectCreator";
const url = require("url");

class LoggerMiddleware {
  constructor(is_active, loggerService) {
    this.is_active = is_active;
    this.loggerService = loggerService;
  }

  generate_curl_from_har = (requestHarObject) => {
    if (!requestHarObject) {
      return "";
    }
    let requestCurl = "";
    try {
      const harObject = cloneDeep(requestHarObject);
      requestCurl = new HTTPSnippet(harObject).convert("shell", "curl", {
        indent: " ",
      });
    } catch (err) {
      // FIX-ME: this always fails on local
      console.error(`LoggerMiddleware.generate_curl_from_har Error: ${err}`);
    }
    return requestCurl;
  };

  send_network_log = (ctx, action_result_objs = [],requestState="") => {
    // let query_params_string;
    // if (ctx.rq.final_request.query_params) {
    //   query_params_string = JSON.stringify(ctx.rq.final_request.query_params);
    // }
    // const log = {
    //   id: ctx.uuid,
    //   timestamp: Math.floor(Date.now() / 1000),
    //   url: url.parse(
    //     (ctx.isSSL ? "https://" : "http://") +
    //       ctx.clientToProxyRequest.headers.host +
    //       ctx.clientToProxyRequest.url
    //   ).href,
    //   request: {
    //     method: ctx.rq.final_request.method,
    //     path: ctx.rq.final_request.host,
    //     host: ctx.rq.final_request.host,
    //     port: ctx.rq.final_request.port,
    //     headers: ctx.rq.final_request.headers,
    //     body: ctx.rq.final_request.body,
    //     query_params: query_params_string,
    //   },
    //   requestShellCurl: this.generate_curl_from_har(
    //     ctx.rq.final_request.requestHarObject
    //   ),
    //   response: {
    //     statusCode: ctx.rq.final_response.status_code,
    //     headers: ctx.rq.final_response.headers || {},
    //     contentType:
    //       (ctx.rq.final_response.headers &&
    //         ctx.rq.final_response.headers["content-type"] &&
    //         ctx.rq.final_response.headers["content-type"].includes(";") &&
    //         ctx.rq.final_response.headers["content-type"].split(";")[0]) ||
    //       (ctx.rq.final_response.headers &&
    //         ctx.rq.final_response.headers["content-type"]),
    //     body: ctx.rq.final_response.body || null,
    //   },
    //   actions: get_success_actions_from_action_results(action_result_objs),
    // };
    // ipcRenderer.send("log-network-request", log);
    // TODO: Sending log for now. Ideally this should be har object
    this.loggerService.addLog(this.createLog(ctx, action_result_objs, requestState), ctx.rq.final_request.headers || {})
  };

  createLog = (ctx, action_result_objs = [], requestState="") => {
    const protocol = ctx.isSSL ? "https" : "http";
    const rqLog = {
      id: ctx.uuid,
      timestamp: Math.floor(Date.now() / 1000),
      finalHar: createHar(
        ctx.rq.final_request.headers,
        ctx.rq.final_request.method,
        protocol,
        getHost(ctx),
        ctx.rq.final_request.path,
        ctx.rq.final_request.body,
        ctx.rq.final_response.status_code,
        ctx.rq.final_response.body,
        ctx.rq.final_response.headers || {},
        ctx.rq.final_request.query_params
      ),
      requestShellCurl: this.generate_curl_from_har(ctx?.rq?.final_request?.requestHarObject), // TODO: Move this to client side
      actions: get_success_actions_from_action_results(action_result_objs),
      consoleLogs : ctx?.rq?.consoleLogs,
      requestState
    }
    return rqLog;
  }
}

export default LoggerMiddleware;
