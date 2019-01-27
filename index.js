const knex_config = require('./knexfile.js')
const knex = require('knex')
const fs = require('fs')
const util = require('util')
const child_process = require('child_process')
const encoding = require('encoding')

const readFile = util.promisify(fs.readFile)

const effiweb = knex(knex_config['effiweb'])
const efficms = knex(knex_config['efficms'])
const effiwp = knex(knex_config['effiwp'])

const root = process.env.ARTICLE_ROOT
const wpRoot = process.env.WP_ROOT
const drupalRoot = process.env.DRUPAL_ROOT

const oldWinstonUsers = efficms('users')
  .then(rows => rows.map(drupalToWpUser))
  .then(users => insertUsers(users).then(updateUsers(users)))

const oldWinstonArticles = () =>
  efficms('node')
    .select('*')
    .then(nodes => Promise.all(nodes.map(handleNode)))

function handleNode(node) {
  if (node.body.length < 1) return Promise.resolve(null)

  return Promise.all([
    nodeWpAuthorId(node),
    efficms('url_alias')
      .select('dst')
      .where('src', `node/${node.nid}`)
  ]).then(([post_author_latin, urls]) => {
    console.log('latin', post_author_latin)
    if (urls.length === 0) return null

    const oldUrls = [].concat
      .apply(
        [],
        urls.map(({ dst }) => [
          `/${dst}`,
          `/${dst.replace(/index\.html$/, '')}`
        ])
      )
      .filter(onlyUnique)
    const post_name = postNameFor({ linktarget: urls[0].dst })
    const newUrl = `/${post_name}`
    const urlPromise = Promise.all(
      oldUrls.map(oldUrl =>
        upsert(
          'wp_redirection_items',
          { url: oldUrl },
          makeWpRedirect(oldUrl, newUrl)
        )
      )
    )

    const post_date = new Date(node.created * 1000)
    const post_title = encoding.convert(node.title, 'latin1', 'UTF-8')
    const post_author = post_author_latin // encoding.convert(post_author_latin, 'latin1', 'UTF-8')
    console.log('post', post_author)
    const post_content = encoding.convert(
      node.body.replace(new RegExp(`<h.>${node.title}</h.>`), ''),
      'latin1',
      'UTF-8'
    )

    const post_excerpt = encoding.convert(node.teaser, 'latin1', 'UTF-8')
    const wpArticle = {
      post_author,
      post_date,
      post_date_gmt: post_date,
      post_modified: post_date,
      post_modified_gmt: post_date,
      to_ping: '',
      pinged: '',
      post_content_filtered: '',
      post_content,
      post_title,
      post_status: 'publish',
      post_name,
      comment_status: 'closed',
      ping_status: 'open',
      post_excerpt,
      post_type: 'post'
    }
    return urlPromise.then(() =>
      upsert('wp_posts', { post_title: wpArticle.post_title }, wpArticle)
    )
  })
}

function nodeWpAuthorId(node) {
  return efficms('users')
    .where({ uid: node.uid })
    .then(rows => rows[0])
    .then(user =>
      effiwp('wp_users')
        .select('ID')
        .where('user_login', wpLoginFor(user.name))
    )
    .then(rows => rows[0].ID)
}

function drupalToWpUser(drUser) {
  return {
    user_login: wpLoginFor(drUser.name),
    user_pass: drUser.pass,
    user_nicename: wpLoginFor(drUser.name),
    user_email: drUser.mail,
    user_registered: new Date(),
    display_name: drUser.name
  }
}

const oldOldEffiUsers = () =>
  effiweb('articles')
    .distinct('author')
    .then(rows => rows.map(r => r.author))
    .then(authors => authors.filter(x => x))
    .then(authors => authors.map(author => makeWpUser(author)))
    .then(insertUsers)

const oldOldArticles = () =>
  effiweb('articles')
    .select('*')
    .then(articles => {
      return Promise.all(articles.map(makeWpArticle)).then(wpArticles => {
        const promises = wpArticles.filter(identity).map(wpArticle => {
          return insertIfMissing(
            'wp_posts',
            { post_title: wpArticle.post_title },
            effiwp('wp_posts').insert(wpArticle)
          )
        })
        return Promise.all(promises)
      })
    })

const cmd = command => child_process.execSync(command, { encoding: 'utf8' })

const oldOldAttachments = () => {
  const uploadsRoot = `${wpRoot}/wp-content/uploads`
  cmd(`mkdir -p ${uploadsRoot}`)
  cmd(`cd ${root} && find . -path ./meta/lib -prune -or -type d -print`)
    .split('\n')
    .forEach(d => cmd(`mkdir -p ${uploadsRoot}/${d}`))
  const promises = cmd(
    `cd ${root} && find . -path ./meta/lib -prune -or -type f -print`
  )
    .split('\n')
    .filter(
      f =>
        f.length > 0 &&
        !f.includes('.htaccess') &&
        !f.endsWith('.html') &&
        !f.endsWith('~') &&
        !f.endsWith('.inc') &&
        !f.endsWith('.php')
    )
    .map(f => {
      console.log(f)
      cmd(`cp "${root}/${f}" "${uploadsRoot}/${f}"`)
      return f
    })
    .map(f => f.replace(/^\./, ''))
    .map(f =>
      insertIfMissing(
        'wp_redirection_items',
        { url: f },
        effiwp('wp_redirection_items').insert(
          makeWpRedirect(f, `/wp-content/uploads${f}`)
        )
      )
    )

  return Promise.all(promises)
}

const oldWinstonFiles = () => {
  const uploadsRoot = `${wpRoot}/wp-content/uploads`
  cmd(`mkdir -p ${uploadsRoot}`)
  const promises = cmd(`cd ${drupalRoot}/files && find . -type f -print`)
    .split('\n')
    .filter(
      f =>
        f.length > 0 &&
        !f.includes('.htaccess') &&
        !f.endsWith('.html') &&
        !f.endsWith('~') &&
        !f.endsWith('.inc') &&
        !f.endsWith('.php')
    )
    .map(f => {
      // console.log(f)
      cmd(`cp "${drupalRoot}/files/${f}" "${uploadsRoot}/${f}"`)
      return f
    })
    .map(f => f.replace(/^\.\//, ''))
    .map(f =>
      insertIfMissing(
        'wp_redirection_items',
        { url: f },
        effiwp('wp_redirection_items').insert(
          makeWpRedirect(
            `.*system\\/files\\?file=${f}`,
            `/wp-content/uploads/${f}`,
            { regex: 1 }
          )
        )
      )
    )

  return Promise.all(promises)
}

const oldOldSpecificArticles = () => {
  const linktargets = [
    'tekijanoikeus/aanitteet',
    'tekijanoikeus/muut',
    'roskaposti',
    'mirrors/etvi',
    'yhdistys/kokoukset',
    'tapahtumat',
    'yhdistys/aktivistit-lista.html',
    'verkossa/linkit.html',
    'yhdistys/palaute',
    'yhdistys/palaute/osoitteenmuutos.html',
    'yhdistys/rekisteriseloste.html'
  ]

  const promises = linktargets.map(linktarget => {
    articleRead(linktarget).then(({ body, title }) => {
      const post_name = postNameForLinktarget(linktarget)
      let post_date =
        dateFromContent(body) || otherDateRules(linktarget) || new Date()
      const wpArticle = {
        post_author: 1,
        post_date,
        post_date_gmt: post_date,
        post_modified: post_date,
        post_modified_gmt: post_date,
        to_ping: '',
        pinged: '',
        post_content_filtered: '',
        post_content: body,
        post_title: title,
        post_status: 'publish',
        post_name,
        comment_status: 'closed',
        ping_status: 'open',
        post_excerpt: '',
        post_type: 'post'
      }
      const oldUrls = linktarget.endsWith('.html')
        ? [`/${linktarget}`]
        : [`/${linktarget}`, `/${linktarget}/`]
      const newUrl = `/${post_name}`
      ;(oldUrls.includes(newUrl)
        ? Promise.resolve(null)
        : Promise.all(
            oldUrls.map(oldUrl =>
              insertIfMissing(
                'wp_redirection_items',
                { url: oldUrl },
                effiwp('wp_redirection_items').insert(
                  makeWpRedirect(oldUrl, newUrl)
                )
              )
            )
          )
      ).then(() =>
        insertIfMissing(
          'wp_posts',
          { post_name: wpArticle.post_name },
          effiwp('wp_posts').insert(wpArticle)
        )
      )
    })
  })
  return Promise.all(promises)
}

const oldOldExplicitRedirects = () => {
  const filePath = `${root}/meta/redirections.inc`
  const guessedEncoding = guessFileEncoding(filePath)
  return readFile(filePath, guessedEncoding).then(contents => {
    const promises = contents
      .split('\n')
      .filter(line => line.includes('=>'))
      .map(line => {
        const matches = /"(.*)".*"(.*)"/.exec(line)

        return insertIfMissing(
          'wp_redirection_items',
          { url: matches[1] },
          effiwp('wp_redirection_items').insert(
            makeWpRedirect(matches[1], `/${matches[2]}`)
          )
        )
      })
    return Promise.all(promises)
  })
}

const categories = {
  'julkaisut/kirjeet': 'Kirjeet',
  'julkaisut/puheet': 'Puheet',
  'roskaposti/': 'Roskaposti',
  'tekijanoikeus/muut/': 'Tekijänoikeus, muut',
  'tekijanoikeus/aanitteet/': 'Tekijänoikeus, äänitteet',
  'blog/': 'Blogi',
  'yhdistys/kokoukset/': 'Kokoukset',
  'yhdistys/toimintasuunnitelmat/': 'Toimintasuunnitelmat',
  'tapahtumat/': 'Tapahtumat',
  effialert: 'Effialert'
}

function categoryForArticle(article) {
  const key = Object.keys(categories).find(category =>
    article.filename.startsWith(category)
  )
  if (key) return categories[key]
  return 'Yleinen'
}

const oldWinstonCategories = () => {
  return efficms('node')
    .select('*')
    .then(nodes =>
      Promise.all(
        nodes.map(node => {
          if (node.body.length < 1) return Promise.resolve(null)
          return efficms('url_alias')
            .select('dst')
            .where('src', `node/${node.nid}`)
            .then(rows => rows.length > 0 && rows[0].dst)
            .then(url => {
              return (
                url &&
                effiwp('wp_terms')
                  .select('term_id')
                  .where('name', categoryForArticle({ filename: url }))
                  .then(rows => rows[0].term_id)
                  .then(term_id =>
                    effiwp('wp_term_taxonomy')
                      .select('term_taxonomy_id')
                      .where('term_id', term_id)
                      .then(rows => rows[0].term_taxonomy_id)
                  )
                  .then(term_taxonomy_id => {
                    const post_title = encoding.convert(
                      node.title,
                      'latin1',
                      'UTF-8'
                    )
                    return effiwp('wp_posts')
                      .select('ID')
                      .where('post_title', post_title)
                      .then(rows => rows[0].ID)
                      .then(post_id => {
                        return insertIfMissing(
                          'wp_term_relationships',
                          { object_id: post_id, term_taxonomy_id },
                          effiwp('wp_term_relationships').insert({
                            object_id: post_id,
                            term_taxonomy_id
                          })
                        )
                      })
                  })
              )
            })
        })
      )
    )
    .then(() => {
      // https://stackoverflow.com/questions/18669256/how-to-update-wordpress-taxonomiescategories-tags-count-field-after-bulk-impo#18669257
      return effiwp.raw(`
  UPDATE wp_term_taxonomy SET count = (
  SELECT COUNT(*) FROM wp_term_relationships rel
      LEFT JOIN wp_posts po ON (po.ID = rel.object_id)
      WHERE
          rel.term_taxonomy_id = wp_term_taxonomy.term_taxonomy_id
          AND
          wp_term_taxonomy.taxonomy NOT IN ('link_category')
          AND
          po.post_status IN ('publish', 'future')
  )
  `)
    })
}

const oldOldCategories = () => {
  return Promise.all(
    Object.values(categories).map(category => {
      return insertIfMissing(
        'wp_terms',
        { name: category },
        effiwp('wp_terms').insert({
          name: category,
          slug: category.replace(', ', '-').toLowerCase(),
          term_group: 0
        })
      )
    })
  )
    .then(() => {
      return Promise.all(
        Object.values(categories).map(category => {
          return effiwp('wp_terms')
            .select('term_id')
            .where('name', category)
            .then(rows => rows[0].term_id)
            .then(term_id => {
              return insertIfMissing(
                'wp_term_taxonomy',
                { term_id },
                effiwp('wp_term_taxonomy').insert({
                  term_id,
                  taxonomy: 'category',
                  description: category
                })
              )
            })
        })
      )
    })
    .then(() => {
      return effiweb('articles')
        .select('*')
        .then(articles => {
          return Promise.all(
            articles.map(article => {
              return effiwp('wp_posts')
                .select('ID')
                .where('post_title', article.title)
                .then(rows => rows.length > 0 && rows[0].ID)
                .then(post_id => {
                  return (
                    post_id &&
                    effiwp('wp_terms')
                      .select('term_id')
                      .where('name', categoryForArticle(article))
                      .then(rows => rows[0].term_id)
                      .then(term_id =>
                        effiwp('wp_term_taxonomy')
                          .select('term_taxonomy_id')
                          .where('term_id', term_id)
                          .then(rows => rows[0].term_taxonomy_id)
                      )
                      .then(term_taxonomy_id => {
                        return insertIfMissing(
                          'wp_term_relationships',
                          { object_id: post_id, term_taxonomy_id },
                          effiwp('wp_term_relationships').insert({
                            object_id: post_id,
                            term_taxonomy_id
                          })
                        )
                      })
                  )
                })
            })
          )
        })
    })
    .then(() => {
      // https://stackoverflow.com/questions/18669256/how-to-update-wordpress-taxonomiescategories-tags-count-field-after-bulk-impo#18669257
      return effiwp.raw(`
UPDATE wp_term_taxonomy SET count = (
SELECT COUNT(*) FROM wp_term_relationships rel
    LEFT JOIN wp_posts po ON (po.ID = rel.object_id)
    WHERE
        rel.term_taxonomy_id = wp_term_taxonomy.term_taxonomy_id
        AND
        wp_term_taxonomy.taxonomy NOT IN ('link_category')
        AND
        po.post_status IN ('publish', 'future')
)
`)
    })
}

const feedRedirects = () => {
  const oldNames = [
    '/xml/uutiset.rss',
    '/xml/effiorg.rss',
    '/xml/uutiset-latin1.rss',
    '/xml/effiorg-latin1.rss'
  ]
  return Promise.all(
    oldNames.map(oldName =>
      effiwp('wp_redirection_items')
        .where({ url: oldName })
        .update(makeWpRedirect(oldName, '/feed/'))
    )
  )
}

oldWinstonUsers.then(oldWinstonArticles).then(console.log)
// oldWinstonUsers.then(oldWinstonFiles).then(console.log)
// oldOldEffiUsers()
//   .then(oldOldArticles)
//   .then(oldOldAttachments)
// oldOldSpecificArticles().then(console.log)
//   .then(oldOldExplicitRedirects)
// feedRedirects().then(console.log)
// oldOldCategories().then(console.log)
// oldWinstonCategories().then(console.log)

function makeWpArticle(article) {
  return Promise.all([articleWpAuthorId(article), articleBody(article)]).then(
    ([post_author, post_content]) => {
      if (!post_content) return null
      const post_date =
        article.published ||
        dateFromContent(post_content) ||
        otherDateRules(article.linktarget)
      if (!post_date) return null

      const oldUrls = [
        `/${article.linktarget}`,
        `/${article.linktarget.replace(/index\.html$/, '')}`,
        `/${article.filename}`,
        `/${article.filename.replace(/index\.html$/, '')}`
      ].filter(onlyUnique)
      const post_name = postNameFor(article)
      const newUrl = `/${post_name}`
      return Promise.all(
        oldUrls.map(oldUrl =>
          upsert(
            'wp_redirection_items',
            { url: oldUrl },
            makeWpRedirect(oldUrl, newUrl)
          )
        )
      ).then(() => ({
        post_author,
        post_date,
        post_date_gmt: post_date,
        post_modified: post_date,
        post_modified_gmt: post_date,
        to_ping: '',
        post_content,
        post_title: article.title,
        post_status: 'publish',
        post_name,
        comment_status: 'closed',
        ping_status: 'open',
        post_excerpt: article.summary || '',
        post_type: 'post'
      }))
    }
  )
}

function otherDateRules(linktarget) {
  if (linktarget.endsWith('toimintasuunnitelma-2003.html'))
    return new Date(2003, 5, 13)
  if (linktarget.endsWith('tekijanoikeus/aanitteet'))
    return new Date(2005, 12, 20)
  return null
}

function dateFromContent(post_content) {
  const match = post_content.match(/(\d{1,2})\.(\d{1,2})\.(\d{2,4})/)
  return match
    ? new Date(Date.UTC(match[3], Number(match[2]) - 1, match[1]))
    : null
}

function postNameFor(article) {
  return postNameForLinktarget(article.linktarget)
}

function postNameForLinktarget(linktarget) {
  return linktarget
    .replace(/\//g, '-')
    .replace('.html', '')
    .replace(/\./g, '-')
}

function articleRead(linktargetIn) {
  const linktarget = linktargetIn.endsWith('.html')
    ? linktargetIn
    : linktargetIn.endsWith('/')
    ? `${linktargetIn}index.html`
    : `${linktargetIn}/index.html`
  const filePath = `${root}/${linktarget}`
  if (!fs.existsSync(filePath)) {
    console.error(`File path ${filePath} doesn't exist!!`)
    return Promise.resolve(null)
  }

  const guessedEncoding = guessFileEncoding(filePath)
  return readFile(filePath, guessedEncoding)
    .then(contents => {
      const title = guessTitle(contents)
      console.log('title', title)
      const body = fixLinks(
        bodyWithoutHeadAndTitleAndPhp(contents, title),
        linktarget
      )
      return { body, title }
    })
    .catch(e => console.error(e) || Promise.resolve(null))
}

function articleBody(article) {
  console.log('AAAAA', article.linktarget)
  if (!article.linktarget.endsWith('.html')) return Promise.resolve(null)
  const filePath = `${root}/${article.linktarget}`
  if (!fs.existsSync(filePath)) return Promise.resolve(null)

  const guessedEncoding = guessFileEncoding(filePath)
  console.log(guessedEncoding)
  return readFile(filePath, guessedEncoding)
    .then(contents => bodyWithoutHeadAndTitleAndPhp(contents, article.title))
    .then(body => fixLinks(body, article.linktarget))
    .catch(e => console.log(e) || Promise.resolve(null))
}

function articleWpAuthorId(article) {
  return article.author
    ? effiwp('wp_users')
        .select('ID')
        .where('user_login', wpLoginFor(article.author))
        .then(rows => rows[0].ID)
    : Promise.resolve(1)
}

function makeWpUser(userName) {
  return {
    user_login: wpLoginFor(userName),
    user_pass: 'disabled',
    user_nicename: wpLoginFor(userName),
    user_email: 'disabled',
    user_registered: new Date(),
    display_name: userName
  }
}

function wpLoginFor(userName) {
  return userName.replace(/[^a-zA-Z]/g, '')
}

function insertUsers(users) {
  const promises = users.map(user => {
    return upsert('wp_users', { user_login: user.user_login }, user)
  })
  return Promise.all(promises)
}

function updateUsers(users) {
  const promises = users.map(user => {
    return effiwp('wp_users')
      .where({ user_login: user.user_login })
      .update(user)
  })
  return Promise.all(promises)
}

function makeWpRedirect(src, target, optsIn) {
  const opts = optsIn || {}
  const regex = opts.regex || 0
  return {
    url: src,
    action_data: target,
    regex,
    position: 0,
    group_id: 1,
    status: 'enabled',
    action_type: 'url',
    action_code: 301,
    match_type: 'url',
    last_access: new Date()
  }
}

function upsert(table, where, object) {
  return effiwp(table)
    .where(where)
    .then(rows =>
      rows.length === 0
        ? effiwp(table).insert(object)
        : effiwp(table)
            .where(where)
            .update(object)
    )
}

function insertIfMissing(table, where, insertQuery) {
  return effiwp(table)
    .where(where)
    .then(rows => (rows.length === 0 ? insertQuery : null))
}

function identity(x) {
  return x
}
function onlyUnique(value, index, self) {
  return self.indexOf(value) === index
}

function bodyWithoutHeadAndTitleAndPhp(contents, title) {
  let inBody = false
  let inPhp = false
  return contents
    .split('\n')
    .filter(line => {
      if (line.includes('<body')) {
        inBody = true
        return false
      }
      if (line.includes('</body>')) {
        inBody = false
        return false
      }
      if (line.includes('<?') && line.includes('?>')) {
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
      if (title && line.search(new RegExp(`<h.*${title}`)) !== -1) return false

      return inBody && !inPhp
    })
    .join('\n')
}

function fixLinks(body, linktarget) {
  return body.replace(/(src|href)="([^"]+)"/g, (match, p1, p2) => {
    if (
      p2.startsWith('http') ||
      p2.startsWith('/') ||
      p2.startsWith('#') ||
      p2.startsWith('\nhttp') ||
      p2.startsWith('mailto:') ||
      p2.startsWith('news:')
    )
      return match

    // Fix broken links
    if (p2.includes('@effi.org')) return `${p1}="mailto:${p2}"`
    if (p2.startsWith('www')) return `${p1}="http://${p2}"`

    // Make relatives absolute
    const linkDir = cmd(`dirname ${linktarget}`)
    return `${p1}="/${linkDir}/${p2}"`
  })
}

function guessFileEncoding(filePath) {
  const fileCommandOutput = child_process
    .spawnSync('file', [filePath, '-b'], { encoding: 'utf8' })
    .stdout.split(',')[1]
    .split(' ')[1]
  const guessedEncoding = ['ISO-8859', 'Non-ISO'].includes(fileCommandOutput)
    ? 'latin1'
    : fileCommandOutput
  return guessedEncoding
}

function guessTitle(contents) {
  const titleMatch = /<title>\s*(.*)\s*<\/title>/.exec(contents)
  const h1Match = /<h1>\s*(.*)\s*<\/h1>/.exec(contents)
  if (titleMatch) return titleMatch[1]
  if (h1Match) return h1Match[1]
  return null
}
