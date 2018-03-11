const knex_config = require('./knexfile.js')
const knex = require('knex')
const fs = require('fs')
const util = require('util')
const child_process = require('child_process')
const readFile = util.promisify(fs.readFile)

const effiweb = knex(knex_config['effiweb'])
const efficms = knex(knex_config['efficms'])
const effiwp = knex(knex_config['effiwp'])

const root = process.env.ARTICLE_ROOT
const wpRoot = process.env.WP_ROOT

const oldOldEffiUsers = effiweb('articles').distinct('author')
  .then(rows => rows.map(r => r.author))
  .then(authors => authors.filter(x => x))
  .then(authors => authors.map(author => makeWpUser(author)))
  .then(insertUsers)

const oldOldArticles = () => effiweb('articles').select('*').then(articles => {
  return Promise.all(articles.map(makeWpArticle)).then(wpArticles => {
    const promises = wpArticles
          .filter(identity)
          .map(wpArticle => {
            return insertIfMissing('wp_posts',
                            {'post_title': wpArticle.post_title},
                            effiwp('wp_posts').insert(wpArticle))
          })
    return Promise.all(promises)
  })
})

const oldOldAttachments = () => {
  const cmd = (command) => child_process.execSync(command, { encoding: 'utf8'})
  const uploadsRoot = `${wpRoot}/wp-content/uploads`
  cmd(`mkdir -p ${uploadsRoot}`)
  cmd(`cd ${root} && find . -path ./meta/lib -prune -or -type d -print`).split('\n')
    .forEach(d => cmd(`mkdir -p ${uploadsRoot}/${d}`))
  cmd(`cd ${root} && find . -path ./meta/lib -prune -or -type f -print`).split('\n')
    .filter(f => f.length > 0
            && !f.includes('.htaccess')
            && !f.endsWith('.html')
            && !f.endsWith('~')
            && !f.endsWith('.inc')
            && !f.endsWith('.php'))
    .forEach(f => console.log(f)||cmd(`cp "${root}/${f}" "${uploadsRoot}/${f}"`))

  return Promise.resolve('ok')

}

// oldOldEffiUsers
//   .then(oldOldArticles)
// oldOldArticles()
oldOldAttachments()
  .then(console.log)

function makeWpArticle(article) {
  return Promise.all([
    articleWpAuthorId(article),
    articleBody(article)
  ]).then(([post_author, post_content]) => {
    if (!post_content) return null
    const post_date = article.published || dateFromContent(post_content) || otherDateRules(article)
    if (!post_date) return null

    return {
      post_author,
      post_date,
      post_content,
      post_title: article.title,
      post_status: 'publish',
      post_name: postNameFor(article),
      comment_status: 'closed',
      ping_status: 'open',
      post_excerpt: article.summary || '',
      post_type: 'post'
    }
  })
}

function otherDateRules(article) {
  if (article.linktarget.endsWith('toimintasuunnitelma-2003.html'))
    return new Date(2003, 5, 13)
  return null
}

function dateFromContent(post_content) {
  const match = post_content.match(/(\d{1,2})\.(\d{1,2})\.(\d{2,4})/)
  return match
    ? new Date(Date.UTC(match[3], Number(match[2]) - 1, match[1]))
    : null
}

function postNameFor(article) {
  return article.linktarget
    .replace(/\//g, '-')
    .replace('\.html', '')
    .replace(/\./g, '-')
}

function articleBody(article) {
  console.log('AAAAA',article.linktarget)
  if (!article.linktarget.endsWith('.html'))
    return Promise.resolve(null)
  const filePath = `${root}/${article.linktarget}`
  if (!fs.existsSync(filePath))
    return Promise.resolve(null)

  let inBody = false
  let inPhp = false
  const fileCommandOutput = child_process.spawnSync('file', [ filePath, '-b' ], { encoding: 'utf8'}).stdout.split(',')[1].split(' ')[1]
  const guessedEncoding = [ 'ISO-8859', 'Non-ISO' ].includes(fileCommandOutput) ? 'latin1' : fileCommandOutput
  console.log(guessedEncoding)
  return readFile(filePath, guessedEncoding)
    .then(contents => contents.split('\n').filter(line => {
      if (line.includes('<body>')) {
        inBody = true
        return false
      }
      if (line.includes('</body>')) {
        inBody = false
        return false
      }
      if (line.includes('<?')) {
        inPhp = true
        return false
      }
      if (line.includes('?>')) {
        inPhp = false
        return false
      }
      if (line.search(new RegExp(`<h1.*${article.title}`)) !== -1)
        return false

      return inBody && !inPhp
    }).join('\n'))
    .catch(e => console.log(e) || Promise.resolve(null))
}

function articleWpAuthorId(article) {
  return (article.author ? effiwp('wp_users').select('ID').where('user_login', wpLoginFor(article.author)).then(rows => console.log(rows, article.author)||rows[0].ID) : Promise.resolve(1))
}

function makeWpUser(userName) {
  return {
    user_login: wpLoginFor(userName),
    user_pass: 'disabled',
    user_nicename: wpLoginFor(userName),
    user_email: 'disabled',
    display_name: userName
  }
}

function wpLoginFor(userName) {
  return userName.replace(/[^a-zA-Z]/g, '')
}

function insertUsers(users) {
  const promises = users.map(user => {
    return insertIfMissing('wp_users', { 'user_login': user.user_login }, effiwp('wp_users').insert(user))
  })
  return Promise.all(promises)
}

function insertIfMissing(table, where, insertQuery) {
  return effiwp(table).where(where)
    .then(rows => rows.length === 0 ? insertQuery : null)
}

function identity(x) { return x }
