import React from "react";
import { graphql } from "gatsby";
import Layout from "../components/layout";
import SEO from "../components/seo";

const BlogPostTemplate = ({ data }) => {
  const post = data.markdownRemark;
  return (
    <Layout>
      <SEO title={post.frontmatter.title} description={post.frontmatter.description} />
      <article>
        <h1>{post.frontmatter.title}</h1>
        <p>{post.frontmatter.date}</p>
        <div dangerouslySetInnerHTML={{ __html: post.html }} />
      </article>
    </Layout>
  );
};

export default BlogPostTemplate;

export const pageQuery = graphql`
  query BlogPostBySlug($slug: String!) {
    markdownRemark(fields: { slug: { eq: $slug } }) {
      id
      excerpt(pruneLength: 160)
      html
      frontmatter {
        title
        date(formatString: "MMMM DD, YYYY")
        description
        tags
        featuredImage {
          childImageSharp {
            gatsbyImageData(width: 800, layout: CONSTRAINED)
          }
        }
      }
      fields {
        slug
        readingTime {
          minutes
        }
      }
    }
  }
`;
