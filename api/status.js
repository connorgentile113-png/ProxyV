module.exports = function handler(request, response) {
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify({ mode: "Serverless reverse proxy" }));
};
