module.exports = {
  siteMetadata: {
    title: 'Test Gatsby Blog',
    description: 'A test Gatsby project for Portage migration',
    siteUrl: 'https://blog.example.com',
  },
  trailingSlash: 'always',
  plugins: [
    'gatsby-plugin-react-helmet',
    'gatsby-plugin-sitemap',
    'gatsby-plugin-image',
    {
      resolve: 'gatsby-source-filesystem',
      options: {
        name: 'posts',
        path: `${__dirname}/src/posts`,
      },
    },
    {
      resolve: 'gatsby-source-filesystem',
      options: {
        name: 'pages',
        path: `${__dirname}/src/pages`,
      },
    },
    {
      resolve: 'gatsby-plugin-mdx',
      options: {
        gatsbyRemarkPlugins: [],
      },
    },
    'gatsby-transformer-remark',
    {
      resolve: 'gatsby-remark-prismjs',
      options: {
        classPrefix: 'language-',
      },
    },
    'gatsby-remark-autolink-headers',
    'gatsby-remark-images',
    {
      resolve: 'gatsby-plugin-feed',
      options: {
        query: '',
        feeds: [],
      },
    },
    'gatsby-plugin-postcss',
  ],
};
