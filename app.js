import axios from 'axios'
import express from 'express'
import cors from 'cors'

const app = express();
app.use(cors())
const port = process.env.PORT || 7555;

const headers = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:108.0) Gecko/20100101 Firefox/108.0',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/jxl,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5',
  'Accept-Encoding': 'gzip, deflate, br',
}

const resourceTypeMap = {'movie': '/movies', 'series': '/tv'}
const requestTimeout = 3000

class ImdbResult {
  constructor(title, year, seriesTitle, seriesIndex) {
    this.title = title
    this.year = year
    this.seriesTitle = seriesTitle
    this.seriesIndex = seriesIndex
  }
}

function stripTags(h) {
  return h.replace(/<([^>]+)([ \/]*)>/gi, '').replace(/<\/([^>]+)>/, '')
}

function katerizeSeriesIndex(seriesIndex) {
  let result = seriesIndex.replace('.', '')
  result = result.replace(/S([1-9])E/gi, 'S0$1E')
  result = result.replace(/E([1-9])$/gi, 'E0$1')
  return result  
}

async function imdbReverseLookup(imdbIdWithEpisodeIndex) {
  const imdbId = imdbIdWithEpisodeIndex.indexOf(':') > 0 ? imdbIdWithEpisodeIndex.substr(0, imdbIdWithEpisodeIndex.indexOf(':')) : imdbIdWithEpisodeIndex
  const url = 'https://www.imdb.com/title/' + imdbId;
  const result = await axios.get(url, { headers: headers })
  if(result.status == 200) {
    const title = result.data.match('<h1([^>]+)hero__pageTitle([^>]+)><span([^>]+)>([^<]+)<( *)\\/span( *)>')[4]
    let seriesTitle = null
    let year = null
    let seriesIndex = null
    if(imdbIdWithEpisodeIndex != imdbId) {
      const p = imdbIdWithEpisodeIndex.split(':')
      seriesIndex = `S${p[1]}E${p[2]}`
    }
    try {
      year = result.data.match('<a([^>]+)href="\\/title\\/'+imdbId+'\\/releaseinfo([^>]+)>([0-9 \\-–]+)<\\/a>')[3]
    } catch(ex) {}
    if(!seriesIndex) {
      try {
        seriesTitle = result.data.match(/<a([^>]+)hero-title-block__series-link([^>]+)>(.+?)<\/a>/gs)[0]
        seriesTitle = stripTags(seriesTitle)
      } catch(ex) {}
      try {
        seriesIndex = result.data.match(/<div([^>]+)hero-subnav-bar-season-episode-numbers-section([^>]+)>(.+?)<\/div>/gi)[0]
        seriesIndex = stripTags(seriesIndex)
      } catch(ex) {}
    }
    return new ImdbResult(title, year, seriesTitle, seriesIndex)
  } else {
    return false
  }
}

async function getMagnetLink(url) {
  const result = await axios.get(url, {headers: headers, timeout: requestTimeout})
  const magnetUrl = result.data.match('href="magnet\\:\\?xt([^"]+)')[1]
  const torrentHash = result.data.match(/(?<=Torrent hash[: ]*)([a-zA-Z0-9]+)/gsi)[0].trim().toLowerCase()
  let name = ''
  let seeders = ''
  let fileSize = ''
  try {
    name = result.data.match(/<span([^>]+)itemprop="name"([^>]*)>([^<]+)/)[3].trim()
  } catch(ex) {}
  try {
    seeders = stripTags(result.data.match(/<div([^>]+)seedBlock([^>]+)>(.+?)<\/div>/gs)[2]).replace(/[^0-9]*/, '')
  } catch(ex) {}
  try {
    fileSize = stripTags(result.data.match(/<div([^>]+)widgetSize([^>]+)>(.+?)<\/div>/gs)[0]).trim()
  } catch(ex) {}
  return {name: 'Kickass', title: `${name}\n👤 ${seeders} 💾 ${fileSize}`, infoHash: torrentHash, magnet: 'magnet:?xt' + magnetUrl}
}

async function searchTorrents(imdbResult, resourceType) {
  if(!(resourceType in resourceTypeMap)) {
    console.log('resource not found: '  + resourceType)
    return false
  }
  let url = 'https://kickasstorrents.to/usearch/'+imdbResult.title+'%20('+imdbResult.year+')/'
  if(resourceType == 'series') {
    url = 'https://kickasstorrents.to/usearch/'+imdbResult.seriesTitle+' '+katerizeSeriesIndex(imdbResult.seriesIndex)
  }
  console.log(url)
  const result = await axios.get(url, { headers: headers, timeout: requestTimeout})
  if(result.status != 200) {
    return false
  }
  const pattern = /<div([^>]+)torrentname([^>]+)>(.+?)<\/div>/gs
  const results = result.data.matchAll(pattern)
  const streams = []
  for(const match of results) {
      if(!match[0].match('href="([^"]*)'+resourceTypeMap[resourceType])) {
        console.log('skip: ' + resourceTypeMap[resourceType])
      }
      const link = match[0].match(/<a([^>]+)href=('|"*)([^ >"]+)('|"*)([^>]+)cellMainLink/)
      if(link == null) {
        continue
      }
      const url_ = 'https://kickasstorrents.to' + link[3]
      const magnetLink = await getMagnetLink(url_)
      streams.push(magnetLink)
    }
  return streams
}

app.get('/stream/:type_/:videoid.json', (req, res) => {
  imdbReverseLookup(req.params.videoid).then((result) => {
    if(result != false) {
      try {
        searchTorrents(result, req.params.type_).then((streams) => {
          res.send({streams: streams})    
        })
      } catch(ex) {}
    }
  })
})

app.get('/manifest.json', (req, res) => {
  res.send({
    "id": "com.stremio-kickass-addon",
    "version": "0.0.3",
    "name": "Kickass Torrents Streams",
    "description": "Streams from Kickass Torrents",
    "types": [ "movie", "series" ],
    "catalogs": [],
    "resources": [{ "name": "stream", "types": [ "movie", "series" ], "idPrefixes": [ "tt" ] }],
    "background": "https://kickasstorrents.to/static/images/logo.png",
    "logo": "https://kickasstorrents.to/static/images/logo.png"
  })
});

app.listen(port, () => {
  console.log(`[server]: Server is running at ${port}`);
});
