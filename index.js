const express = require('express');
const bodyParser = require('body-parser');
const { getCIBuildResults } = require('./ci');
const fetch = require('node-fetch');

const app = express();
app.set('views', './views');
app.set('view engine', 'ejs');
app.use(bodyParser.json());

const request = {
  text: async (url, options = {}) => {
     return fetch(url, options).then(res => res.text());
  },
  json: async (url, options = {}) => {
    options.headers = options.headers || {};
    options.headers.Accept = 'application/json';
    return fetch(url, options).then(res => res.json());
  }
};

app.get('/', (req, res) => {
  res.render('index');
});

app.post('/api/check', (req, res) => {
  var response = req.body;

  getCIBuildResults(req.body.jobType, req.body.jobId, request)
  .then((results) => {
    response.results = results;
    res.json(response);
  })
  .catch((e) => {
    console.log(e);
    res.status(500).json({});
  });
});

app.listen(process.env.PORT || 3000, () => {
  console.log('App started');
});
